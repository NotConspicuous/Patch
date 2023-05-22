import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as esbuild from 'esbuild';
import chalk from 'chalk';
import NodeCache from 'node-cache';
import http from 'node:http';
import https from 'node:https';
import ProgressBar from 'progress';
import os from 'os';
import resolve from 'resolve';
import { createRequire, builtinModules } from 'module';
// get external standard library modules
// create array of all standard library modules
const stdlib = builtinModules;



const __dirname = new URL('.', import.meta.url).pathname;
const cores = os.cpus().length;
const cache = new NodeCache();

const require = createRequire(import.meta.url);
const builtInModules = new Set(require('module').builtinModules);

let to_download = 0;
let done = 0;

// if cores / 2 is greater than 1 then use that, otherwise use 1 and max at 4 concurrent downloads
const maxConcurrentDownloads = Math.round(cores / 2 > 1 ? cores / 2 : 1 > 4 ? 4 : 1);
// const maxConcurrentDownloads = 1;

const httpAgent = new http.Agent({ 
  maxSockets: maxConcurrentDownloads, 
  // keepAlive: true 
});
const httpsAgent = new https.Agent({ 
  maxSockets: maxConcurrentDownloads, 
  // keepAlive: true 
});

class DynamicProgressBar extends ProgressBar {
  constructor(format, options) {
    super(format, options);
    this.lastModule = "module";
  }

  setTotal(newTotal) {
    this.total = newTotal;
  }

  setCurrentModule(module) {
    this.fmt = this.fmt.replace(this.lastModule, module);

    this.lastModule = module;
  }
}

// on exit, show the cursor
process.on('exit', () => {
  process.stdout.write('\x1B[?25h');
});

// on ctrl+c, show the cursor
process.on('SIGINT', () => {
  process.stdout.write('\x1B[?25h');
  process.exit(1);
});

let console = new class {
  constructor() {
    // hide the cursor
    process.stdout.write('\x1B[?25l');

    this.module = "";
    this.bar = new DynamicProgressBar('📦 Bundling :current/:total ['+chalk.blueBright(':bar')+'] ' + chalk.dim('module'), {
      complete: '=',
      incomplete: ' ',
      width: 40,
      total: 100,
      clear: true,
    });
  }

  pack(module) {
    // trunctate the module name so it fits in the progress bar
    let trunacated_module = module;
    if (module.length > 20) {
      trunacated_module = module.substring(0, 50) + "...";
    }
    this.bar.setCurrentModule(trunacated_module);
    this.bar.tick();
    this.bar.render();
  }

  log(string) {
    // interrupt the progress bar
    // check if bar is terminated
    this.bar.interrupt("\x1B[K" + `🐞 ${string}`);
  }
  info(string) {
    this.bar.interrupt("\x1B[K" + `i ${string}`);
  }
  warn(string) {
    this.bar.interrupt("\x1B[K" + `⚠️ ${string}`);
  }
  error(string) {
    this.bar.interrupt("\x1B[K" + `❌ ${string}`);
    this.bar.terminate();
    process.exit(1);
  }
  success(string) {
    this.bar.interrupt("\x1B[K" + `🚀 ${string}`);
  }
}

const httpPlugin = {
  name: 'http',
  setup(build) {
    const filters = [
      { filter: /^https?:\/\//, namespace: 'http-url' },
      { filter: /^http?:\/\//, namespace: 'http-url' },
      { filter: /^(\.|\/|[a-zA-Z0-9])/, namespace: 'file' },
      { filter: /^node_modules\//, namespace: 'file' },
      { filter: /^[^./]/, namespace: 'file' },
    ];

    filters.forEach(({ filter, namespace }) => {
      build.onResolve({ filter }, async (args) => {
        let resolvedPath = args.path;

        if (namespace === 'http-url') {
          const urlPath = new URL(args.path, args.importer).href;
          return {
            path: urlPath,
            namespace: 'http-url',
          };
        }

        if (args.importer) {
          if (args.importer.startsWith('http://') || args.importer.startsWith('https://')) {
            const urlPath = new URL(args.path, args.importer).href;
            return {
              path: urlPath,
              namespace: 'http-url',
            };
          }

          if (builtInModules.has(args.path)) {
            return {
              path: args.path,
              external: true,
            };
          }
        }

        // check if the file exists
        try {
          let resolvedPath = args.path;
          if (args.importer) {
            resolvedPath = path.resolve(path.dirname(args.importer), args.path);
          }

          await fs.access(resolvedPath);
          return {
            path: resolvedPath,
            namespace,
          };
        } catch (e) {}

        try {
          // use createRequire to resolve the path
          resolvedPath = require.resolve(args.path, { paths: [path.dirname(args.importer)] });
          resolvedPath = path.resolve(resolvedPath);
          return {
            path: resolvedPath,
            namespace,
          };
        } catch (e) {}

        console.error('Could not resolve path: ' + args.path);
      });
    });

    build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args) => {
      to_download++;
      const contents = await fetchAndCache(args.path);
      console.bar.setTotal(to_download);
      console.pack(args.path);
      return { contents, resolveDir: '' };
    });

    build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
      to_download++;
      const contents = await fs.readFile(args.path, 'utf-8');
      console.bar.setTotal(to_download);
      console.pack(args.path);
      return { contents, resolveDir: path.dirname(args.path) };
    });

    // on external modules, just console.log the info
    build.onResolve({ filter: /.*/, namespace: 'external' }, async (args) => {
      console.info(`External module: ${args.path}`);
    });
  },
};


let was_http_last = false;

class Fetcher {
  constructor() {
    this.queue = [];
    this.activeRequests = 0;
    this.maxRequests = 5;
  }

  async fetchAndCache(url) {
    return new Promise((resolve, reject) => {
      this.queue.push({ url, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.activeRequests >= this.maxRequests || this.queue.length === 0) {
      return;
    }

    const { url, resolve, reject } = this.queue.shift();
    this.activeRequests++;

    try {
      const contents = await this.fetchWithRetries(url);
      resolve(contents);
    } catch (error) {
      // Re-add the module to the queue if it fails
      this.queue.push({ url, resolve, reject });
    } finally {
      this.activeRequests--;
      this.processQueue();
    }
  }

  async fetchWithRetries(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const contents = await this.fetchAndCacheSingle(url);
        return contents;
      } catch (error) {
        if (i === retries - 1) {
          throw error;
        }
      }
    }
  }

  async fetchAndCacheSingle(url) {
    // Your existing fetchAndCache implementation
  }
}


async function fetchAndCache(url) {
  const requestTimeout = 5000;

  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Handle remote URLs
    // if http, print warning explaining that it's not secure
    if (url.startsWith('http://') && !was_http_last) {
      console.warn(`Warning: Using http is not a secure method of downloading scripts. Please use https.`);
      console.bar.render();
      was_http_last = true;
    }

    return new Promise((resolve, reject) => {
      function fetch(url, redirects = 0) {
        if (redirects > 20) {
          // reject(new Error('Too many redirects'));
          const error = new Error(`GET ${url} failed: status ${res.statusCode}`);
          console.error(error);
          return;
        }

        // check if the url can be redirected to https
        if (url.startsWith('http://')) {
          // check if the url can be redirected to https without error synchronously
          
        }

        const lib = url.startsWith('https') ? https : http;
        const agent = url.startsWith('https') ? httpsAgent : httpAgent;
        const req = lib.get(url, { agent }, (res) => {
          if ([301, 302, 307].includes(res.statusCode)) {
            fetch(new URL(res.headers.location, url).toString(), redirects + 1);
            req.abort();
          } else if (res.statusCode === 200) {
            let chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const contents = Buffer.concat(chunks).toString();
              cache.set(url, contents);
              resolve(contents);
            });
          } else {
            const error = new Error(`GET ${url} failed: status ${res.statusCode}`);
            console.error(error);
          }
        }).on('error', reject);

        req.setTimeout(requestTimeout, () => {
          req.abort();
          reject(new Error(`Request timeout after ${requestTimeout} ms`));
        });
      }
      fetch(url);
    });
  } else {
    // Handle local file paths
    try {
      const contents = await fs.readFile(url, 'utf-8');
      cache.set(url, contents);
      return contents;
    } catch (error) {
      console.error(error);
    }
  }
}


esbuild.build({
  entryPoints: [path.join(process.cwd(), 'bundle.mjs')],
  outfile: 'bundle.cjs',
  bundle: true,
  treeShaking: true,
  // use import instead of require
  format: 'iife',
  platform: 'node',
  target: 'es2020',
  sourcemap: true,

  external: stdlib,

  minify: true,
  logLevel: 'silent',
  plugins: [
    httpPlugin
  ],
  
})
  .then(async () => {
    let time_start = performance.now()
    const entryPoints = [path.join(process.cwd(), 'test.js')]; // Add more entry points here if needed
    // console.log(entryPoints);
    const contentsPromises = entryPoints.map(entryPoint => fetchAndCache(entryPoint));
    await Promise.all(contentsPromises);
    let time_end = performance.now()
    let time_taken = time_end - time_start;
    // done.
    // log(`${url}`);
    console.success(`Done in ${Math.round(time_taken * 1000) / 100} seconds`);
    console.bar.terminate();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
