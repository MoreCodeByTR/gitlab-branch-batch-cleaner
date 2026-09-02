#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const appHome = path.resolve(process.env.GITLAB_BRANCH_CLEANER_HOME || path.join(os.homedir(), '.gitlab-branch-cleaner'));
const pidFile = path.resolve(process.env.GITLAB_BRANCH_CLEANER_PID_FILE || path.join(appHome, 'gitlab-branch-cleaner.pid'));
const logFile = path.resolve(process.env.GITLAB_BRANCH_CLEANER_LOG_FILE || path.join(appHome, 'gitlab-branch-cleaner.log'));
const updateCheckTimeout = readPositiveInteger(process.env.GITLAB_BRANCH_CLEANER_UPDATE_CHECK_TIMEOUT, 1500);
const args = process.argv.slice(2);
const colorsEnabled = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);
const colorCodes = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m'
};

function color(name, text) {
  if (!colorsEnabled) {
    return text;
  }
  return `${colorCodes[name] || ''}${text}${colorCodes.reset}`;
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function colorUrl(value) {
  return color(isLocalUrl(value) ? 'cyan' : 'green', value);
}

function updateLabel() {
  return color('yellow', '[update]');
}

function usage() {
  console.log(`GitLab Branch Cleaner

Usage:
  gitlab-branch-cleaner start [--host 127.0.0.1] [--port 4178] [--open]
  gitlab-branch-cleaner pause
  gitlab-branch-cleaner stop
  gitlab-branch-cleaner status
  gitlab-branch-cleaner --version
  gitlab-branch-cleaner [--host 127.0.0.1] [--port 4178] [--open]

Environment:
  HOST                         监听地址，默认 127.0.0.1
  PORT                         起始端口，默认 4178
  GITLAB_BRANCH_CLEANER_UPDATE_CHECK_TIMEOUT  版本检查超时时间，默认 1500ms
  GITLAB_BRANCH_CLEANER_HOME   PID 和日志目录
  GITLAB_BRANCH_CLEANER_PID_FILE
  GITLAB_BRANCH_CLEANER_LOG_FILE`);
}

function readPositiveInteger(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return fallback;
  }
  return number;
}

function readOption(optionArgs, name, fallback) {
  const inline = optionArgs.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = optionArgs.indexOf(name);
  if (index >= 0 && optionArgs[index + 1] && !optionArgs[index + 1].startsWith('--')) {
    return optionArgs[index + 1];
  }
  return fallback;
}

function hasFlag(optionArgs, name) {
  return optionArgs.includes(name);
}

function readPort(optionArgs) {
  const value = readOption(optionArgs, '--port', process.env.PORT || '4178');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('端口必须是 0 到 65535 之间的整数。');
  }
  return port;
}

function printVersion() {
  console.log(packageJson.version || '0.0.0');
}

function npmRegistryPackageUrl() {
  const registry =
    process.env.GITLAB_BRANCH_CLEANER_NPM_REGISTRY ||
    process.env.npm_config_registry ||
    process.env.NPM_CONFIG_REGISTRY ||
    'https://registry.npmjs.org/';
  const baseUrl = registry.endsWith('/') ? registry : `${registry}/`;
  return new URL(`./${encodeURIComponent(packageJson.name)}`, baseUrl).toString();
}

function debugUpdateCheck(error) {
  if (process.env.GITLAB_BRANCH_CLEANER_DEBUG_UPDATE_CHECK !== '1') {
    return;
  }
  console.warn(`版本检查已跳过：${error.message || error}`);
}

function requestJson(url, timeout = updateCheckTimeout, redirects = 2) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' ? http : https;
    const request = transport.get(
      parsedUrl,
      {
        headers: {
          Accept: 'application/vnd.npm.install-v1+json, application/json',
          'User-Agent': `${packageJson.name || 'gitlab-branch-cleaner'}/${packageJson.version || '0.0.0'}`
        },
        timeout
      },
      (response) => {
        const location = response.headers.location;
        if (location && response.statusCode >= 300 && response.statusCode < 400 && redirects > 0) {
          response.resume();
          resolve(requestJson(new URL(location, parsedUrl).toString(), timeout, redirects - 1));
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`npm registry responded with ${response.statusCode}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) {
            request.destroy(new Error('npm registry response is too large'));
          }
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('npm update check timed out'));
    });
    request.on('error', reject);
  });
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version || '').trim()
  );
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart == null) {
      return -1;
    }
    if (rightPart == null) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsNumeric = /^\d+$/.test(leftPart);
    const rightIsNumeric = /^\d+$/.test(rightPart);
    if (leftIsNumeric && rightIsNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftIsNumeric) {
      return -1;
    }
    if (rightIsNumeric) {
      return 1;
    }
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) {
    return 0;
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

async function latestVersionUpdateNotice() {
  try {
    if (!packageJson.name || !packageJson.version) {
      return '';
    }

    const metadata = await requestJson(npmRegistryPackageUrl());
    const latestVersion = metadata?.['dist-tags']?.latest;
    if (!latestVersion || compareSemver(latestVersion, packageJson.version) <= 0) {
      return '';
    }

    return `${updateLabel()} 发现新版本：${packageJson.name}@${latestVersion}。执行 npm install -g ${packageJson.name}@latest 更新。`;
  } catch (error) {
    debugUpdateCheck(error);
    return '';
  }
}

async function printUpdateNotice(noticePromise) {
  const notice = await noticePromise;
  if (notice) {
    console.log(notice);
  }
}

function readPidInfo() {
  try {
    const content = fs.readFileSync(pidFile, 'utf8');
    try {
      return JSON.parse(content);
    } catch {
      return { pid: Number(content.trim()) };
    }
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function removePidFile() {
  await fsp.unlink(pidFile).catch(() => undefined);
}

function writePidInfo(info) {
  fs.writeFileSync(pidFile, `${JSON.stringify(info, null, 2)}\n`);
}

async function fileSize(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function readNewLogLines(offset) {
  try {
    const handle = await fsp.open(logFile, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.max(0, stat.size - offset);
      if (length === 0) {
        return [];
      }

      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function readRecentLogLines(targetLogFile, maxBytes = 128 * 1024) {
  try {
    const handle = await fsp.open(targetLogFile, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      if (length === 0) {
        return [];
      }

      const offset = stat.size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);

      let text = buffer.toString('utf8');
      if (offset > 0) {
        const firstLineBreak = text.indexOf('\n');
        text = firstLineBreak === -1 ? '' : text.slice(firstLineBreak + 1);
      }
      return text.split(/\r?\n/).filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function startupSummary(lines) {
  const summary = {
    url: '',
    other: []
  };

  for (const line of lines) {
    if (line.startsWith('GitLab Branch Cleaner is running at ')) {
      summary.url = line.slice('GitLab Branch Cleaner is running at '.length).trim();
    } else {
      summary.other.push(line);
    }
  }

  return summary;
}

function latestStartupLines(lines) {
  let startIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('GitLab Branch Cleaner is running at ')) {
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1) {
    return [];
  }

  const block = [];
  for (const line of lines.slice(startIndex)) {
    block.push(line);
    break;
  }
  return block;
}

function summaryFromPidInfo(info) {
  if (!info || typeof info !== 'object') {
    return startupSummary([]);
  }

  return {
    url: typeof info.url === 'string' ? info.url : '',
    other: []
  };
}

function mergeSummaries(primary, fallback) {
  return {
    url: primary.url || fallback.url,
    other: primary.other.length > 0 ? primary.other : fallback.other
  };
}

async function runningSummary(info) {
  const recentLines = await readRecentLogLines(info.logFile || logFile);
  return mergeSummaries(summaryFromPidInfo(info), startupSummary(latestStartupLines(recentLines)));
}

function startupInfoFromSummary(summary) {
  return {
    url: summary.url
  };
}

function printDetails(summary) {
  if (summary.url) {
    console.log(`${color('gray', '访问地址:')} ${colorUrl(summary.url)}`);
  }
  for (const line of summary.other) {
    console.log(line);
  }
}

function printRunning(pid, summary, message = 'GitLab Branch Cleaner 正在运行') {
  console.log(`${message}，pid ${pid}`);
  printDetails(summary);
}

async function waitForStartup(child, offset, timeout = 5000) {
  const startedAt = Date.now();
  let childExited = false;
  let lines = [];

  child.once('exit', () => {
    childExited = true;
  });

  while (Date.now() - startedAt < timeout) {
    lines = await readNewLogLines(offset);
    const summary = startupSummary(lines);
    if (summary.url) {
      return { lines, childExited };
    }

    if (childExited) {
      return { lines, childExited };
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return { lines, childExited };
}

async function startManaged(serverArgs) {
  await fsp.mkdir(appHome, { recursive: true });
  await fsp.mkdir(path.dirname(pidFile), { recursive: true });
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  const updateNoticePromise = latestVersionUpdateNotice();

  const previous = readPidInfo();
  if (previous?.pid && isRunning(previous.pid)) {
    printRunning(
      previous.pid,
      await runningSummary(previous),
      'GitLab Branch Cleaner 已在运行'
    );
    await printUpdateNotice(updateNoticePromise);
    return;
  }

  await removePidFile();

  const logOffset = await fileSize(logFile);
  const out = fs.openSync(logFile, 'a');
  const childEnv = { ...process.env };
  delete childEnv.FORCE_COLOR;
  const child = spawn(process.execPath, [__filename, ...serverArgs], {
    cwd: packageRoot,
    detached: true,
    env: childEnv,
    stdio: ['ignore', out, out]
  });

  child.unref();

  const pidInfo = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd: packageRoot,
    logFile,
    args: serverArgs
  };
  writePidInfo(pidInfo);

  const { lines, childExited } = await waitForStartup(child, logOffset);
  const summary = startupSummary(lines);
  const started = summary.url && isRunning(child.pid);

  if (!started) {
    await removePidFile();
    const detail = lines.length > 0 ? lines.slice(-6).join('\n') : '未读取到启动日志';
    throw new Error(childExited ? `GitLab Branch Cleaner 启动失败：\n${detail}` : `GitLab Branch Cleaner 启动超时：\n${detail}`);
  }

  writePidInfo({
    ...pidInfo,
    ...startupInfoFromSummary(summary)
  });

  console.log(`GitLab Branch Cleaner 已启动，pid ${child.pid}`);
  printDetails(summary);
  await printUpdateNotice(updateNoticePromise);
}

async function stopManaged() {
  const current = readPidInfo();
  if (!current?.pid) {
    console.log('GitLab Branch Cleaner 未在运行');
    return;
  }

  if (!isRunning(current.pid)) {
    await removePidFile();
    console.log('GitLab Branch Cleaner 未在运行');
    return;
  }

  process.kill(current.pid, 'SIGTERM');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (!isRunning(current.pid)) {
      await removePidFile();
      console.log('GitLab Branch Cleaner 已暂停');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  process.kill(current.pid, 'SIGKILL');
  await removePidFile();
  console.log('GitLab Branch Cleaner 已暂停');
}

async function statusManaged() {
  const current = readPidInfo();
  if (current?.pid && isRunning(current.pid)) {
    printRunning(current.pid, await runningSummary(current));
    return;
  }

  if (current?.pid) {
    await removePidFile();
  }
  console.log('GitLab Branch Cleaner 未在运行');
}

async function runForeground(optionArgs) {
  const host = readOption(optionArgs, '--host', process.env.HOST || '127.0.0.1');
  const port = readPort(optionArgs);
  const shouldOpen = hasFlag(optionArgs, '--open');

  await startServer({ host, port, shouldOpen });
}

async function main() {
  const command = args[0];
  const commandArgs = args.slice(1);

  if (command === 'start') {
    await startManaged(commandArgs);
  } else if (command === 'pause' || command === 'stop') {
    await stopManaged();
  } else if (command === 'status') {
    await statusManaged();
  } else if ((command === '--version' || command === '-v') && commandArgs.length === 0) {
    printVersion();
  } else if ((command === '--help' || command === '-h') && commandArgs.length === 0) {
    usage();
  } else {
    await runForeground(args);
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
