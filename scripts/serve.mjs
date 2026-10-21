#!/usr/bin/env node
/**
 * serve.mjs — a tiny static server for testing locally: `npm start`, then open http://localhost:8000
 *
 * On localhost the page doesn't load analytics and marks submissions is_test = true.
 * To try it on your phone on the same Wi-Fi, use http://<your computer's IP>:8000/?test=1
 * (crypto.randomUUID needs https or localhost; submit.mjs has a fallback).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = +process.env.PORT || 8000;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(root, url));
  if (!file.startsWith(root) || file.includes(`${path.sep}.`)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, () => console.log(`UWMathFinder Lab on http://localhost:${port}`));
