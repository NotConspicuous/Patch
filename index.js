import path from 'path';
import * as esbuild from 'esbuild'
import https from 'node:https'
import http from 'node:http'
import chalk from "chalk"
import NodeCache from 'node-cache';

const cache = new NodeCache();

let httpPlugin = {
  name: 'http',
  setup(build) {
    build.onResolve({ filter: /^https?:\/\// }, args => ({
      path: args.path,
      namespace: 'http-url',
    }))

    build.onResolve({ filter: /.*/, namespace: 'http-url' }, args => ({
      path: new URL(args.path, args.importer).toString(),
      namespace: 'http-url',
    }))

    build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args) => {
      const cachedContents = cache.get(args.path);
      if (cachedContents) {
        return { contents: cachedContents };
      }

      let contents = await fetchAndCache(args.path);
      return { contents }
    })
  },
}

function fetchAndCache(url) {
  return new Promise((resolve, reject) => {
    function fetch(url) {
      process.stdout.write("\r\x1B[K" + `📦 ${url}\r`);
      let lib = url.startsWith('https') ? https : http;
      let req = lib.get(url, res => {
        if ([301, 302, 307].includes(res.statusCode)) {
          fetch(new URL(res.headers.location, url).toString());
          req.abort();
        } else if (res.statusCode === 200) {
          let chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const contents = Buffer.concat(chunks).toString();
            cache.set(url, contents);
            resolve(contents);
          });
        } else {
          reject(new Error(`GET ${url} failed: status ${res.statusCode}`));
        }
      }).on('error', reject);
    }
    fetch(url);
  });
}

esbuild.build({
  entryPoints: [path.join(process.cwd(), 'test.js')],
  outfile: 'bundle.js',
  bundle: true,
  treeShaking: true,
  format: 'esm',
  platform: 'node',
  minify: true,
  logLevel: 'info',
  plugins: [
    httpPlugin,
    {
      name: 'custom-logger',
      setup(build) {
        build.onResolve({ filter: /.*\// }, args => {
          const relativePath = path.relative(process.cwd(), args.importer);

          process.stdout.write("\r\x1B[K" + `📦 file://${args.importer}`);
        })
      },
    },
  ],
})
  .then(async () => {
    const entryPoints = [path.join(process.cwd(), 'test.js')]; // Add more entry points here if needed
    const contentsPromises = entryPoints.map(entryPoint => fetchAndCache(entryPoint));
    await Promise.all(contentsPromises);
    // done.
  })
  .catch(() => {
    process.exit(1);
  });
