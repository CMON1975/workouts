#!/usr/bin/env node
// Usage: node scripts/hash-password.js   (prompts for password, prints bcrypt hash)
//        echo 'pw' | node scripts/hash-password.js   (reads from stdin)

import bcrypt from 'bcrypt';
import readline from 'node:readline';
import { Writable } from 'node:stream';

const ROUNDS = 12;

async function readPasswordTTY() {
  const mutedStdout = new Writable({
    write(chunk, enc, cb) {
      if (!this.muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  mutedStdout.muted = false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutedStdout,
    terminal: true,
  });
  process.stdout.write('Password: ');
  mutedStdout.muted = true;
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\n$/, '');
}

const pw = process.stdin.isTTY ? await readPasswordTTY() : await readStdin();
if (!pw) {
  console.error('empty password');
  process.exit(1);
}
const hash = await bcrypt.hash(pw, ROUNDS);
process.stdout.write(hash + '\n');
