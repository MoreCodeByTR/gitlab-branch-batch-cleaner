import { spawn } from 'node:child_process';

const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
    }
    stopAll(child);
  });
  return child;
}

function stopAll(except) {
  for (const child of children) {
    if (child !== except && !child.killed) {
      child.kill('SIGTERM');
    }
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(143);
});

run(process.execPath, ['./bin/gitlab-branch-cleaner.js', '--port', '4178']);
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1']);
