const path = require('path')
const bunyan = require('bunyan')
const git = require('gift')
const got = require('got')
const execa = require('execa')
const Listr = require('listr')
const split = require('split')
const writeFile = require('write-file-promise')
const heading = require('mdast-util-heading-range')
const remark = require('remark')
const u = require('unist-builder')
const fs = require('mz/fs')
const fecha = require('fecha')
require('any-observable/register/rxjs-all')
const { merge } = require('rxjs')
const { filter } = require('rxjs/operators')
const streamToObservable = require('@samverschueren/stream-to-observable')

const pkg = require('./package.json')

const log = bunyan.createLogger({
  name: 'caniuseLite',
  serializers: { err: bunyan.stdSerializers.err },
  streams: [
    {
      path: path.join(__dirname, 'error.log')
    }
  ]
})

// Cache this so we don't exit early.
const currentVersion = pkg.devDependencies['caniuse-db']

const repo = git(__dirname)

// With thanks: https://github.com/sindresorhus/np
const exec = (cmd, args) => {
  let cp = execa(cmd, args)

  return merge(
    streamToObservable(cp.stdout.pipe(split())),
    streamToObservable(cp.stderr.pipe(split())),
    cp
  ).pipe(filter(Boolean))
}

const enabled = ctx => ctx.version !== currentVersion

const changelog = ctx => tree =>
  heading(tree, /^1.x release/i, (start, nodes, end) => {
    let addition = u('listItem', { loose: false, checked: null }, [
      u('paragraph', [
        u('strong', [u('text', ctx.version)]),
        u(
          'text',
          ` was released on ${fecha.format(
            new Date(),
            'MMMM Do, YYYY [at] HH:mm'
          )}.`
        )
      ])
    ])
    let list = nodes.find(node => node.type === 'list')
    if (!list) {
      list = u('list', { loose: false, ordered: false }, [addition])
      nodes.push(list)
    } else {
      list.children.unshift(addition)
    }
    return [start, ...nodes, end]
  })

const tasks = new Listr([
  {
    title: 'Querying for a new caniuse-db version',
    task: (ctx, task) =>
      got('https://registry.npmjs.org/caniuse-db', {
        json: true
      }).then(response => {
        let version = (ctx.version = response.body['dist-tags'].latest)
        if (enabled(ctx)) {
          task.title = `Upgrading ${currentVersion} => ${version}`
        } else {
          task.title = `Already up to date! (v${version})`
        }
      })
  },
  {
    title: 'Syncing local repository',
    task: () =>
      new Promise((resolve, reject) => {
        repo.pull(err => {
          if (err) {
            return reject(err)
          }
          return resolve()
        })
      }),
    enabled
  },
  {
    title: 'Updating local caniuse-db version',
    task: ctx => {
      pkg.devDependencies['caniuse-db'] = ctx.version
      return writeFile('./package.json', `${JSON.stringify(pkg, null, 2)}\n`)
    },
    enabled
  },
  {
    title: 'Retrieving dependencies from npm',
    task: () => exec('yarn', ['install']),
    enabled
  },
  {
    title: 'Packing caniuse data',
    task: () => exec('npx', ['babel-node', 'src/packer/index.js']),
    enabled
  },
  {
    title: 'Running tests',
    task: () => exec('yarn', ['test']),
    enabled
  },
  {
    title: 'Updating changelog',
    task: ctx => {
      let log2 = './CHANGELOG.md'
      return fs
        .readFile(log2, 'utf8')
        .then(contents => remark().use(changelog, ctx).process(contents))
        .then(contents => writeFile(log2, String(contents)))
    },
    enabled
  },
  {
    title: 'Staging files for commit',
    task: () =>
      new Promise((resolve, reject) => {
        repo.add(
          ['./data', './CHANGELOG.md', './package.json', './yarn.lock'],
          err => {
            if (err) {
              return reject(err)
            }
            return resolve()
          }
        )
      }),
    enabled
  },
  {
    title: 'Committing changes',
    task: ctx =>
      new Promise((resolve, reject) => {
        repo.commit(`Update caniuse-db to ${ctx.version}`, err => {
          if (err) {
            return reject(err)
          }
          return resolve()
        })
      }),
    enabled
  },
  {
    title: 'Updating version',
    task: ctx => exec('npm', ['version', ctx.version]),
    enabled
  },
  {
    title: 'Publishing to npm',
    task: () => exec('npx', ['clean-publish']),
    enabled
  },
  {
    title: 'Syncing repo & tags to GitHub',
    task: () => exec('git', ['push', '--follow-tags']),
    enabled
  }
])

tasks.run().catch(err => log.error({ err }, `Publish failed.`))
