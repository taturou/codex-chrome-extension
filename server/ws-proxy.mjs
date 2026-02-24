import { spawn } from 'node:child_process';
import { createServer, connect as connectTcp } from 'node:net';

const listenHost = process.env.WS_PROXY_LISTEN_HOST ?? '127.0.0.1';
const listenPortSeed = Number(process.env.WS_PROXY_LISTEN_PORT ?? '43172');
const portSearchLimit = Number(process.env.WS_PROXY_PORT_SEARCH_LIMIT ?? '200');
const upstreamHost = process.env.WS_PROXY_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPortSeed = Number(process.env.WS_PROXY_UPSTREAM_PORT ?? '43171');
const codexCommand = process.env.WS_PROXY_CODEX_COMMAND ?? 'codex';
const codexArgsExtra = (process.env.WS_PROXY_CODEX_ARGS ?? '').trim();
const forwardCodexLogs = process.env.WS_PROXY_FORWARD_CODEX_LOGS === '1';

function stripPerMessageDeflate(headersBlock) {
  const lines = headersBlock.split('\r\n');
  const filtered = lines.filter((line) => {
    const lower = line.toLowerCase();
    return !lower.startsWith('sec-websocket-extensions:');
  });
  return filtered.join('\r\n');
}

function parseHeadersEnd(buf) {
  return buf.indexOf('\r\n\r\n');
}

function assertPort(name, value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}

function listenOnce(server, host, port, exclusive = true) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive });
  });
}

async function listenWithAutoPort(server, host, seedPort, maxAttempts) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = seedPort + offset;
    if (port > 65535) {
      break;
    }
    try {
      await listenOnce(server, host, port);
      return port;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No available port found from ${seedPort} (${maxAttempts} attempts)`);
}

async function reserveOpenPort(host, seedPort, maxAttempts) {
  const reservation = createServer();
  let reservedPort;
  try {
    reservedPort = await listenWithAutoPort(reservation, host, seedPort, maxAttempts);
    return {
      port: reservedPort,
      release: () =>
        new Promise((resolve) => {
          reservation.close(() => resolve());
        }),
    };
  } catch (error) {
    reservation.close();
    throw error;
  }
}

const server = createServer();
let upstreamPort = upstreamPortSeed;
let codexProcess;
let startupCompleted = false;
let isShuttingDown = false;

server.on('connection', (client) => {
  let upstream;
  let headerBuffer = Buffer.alloc(0);
  let upgraded = false;

  const closeBoth = () => {
    client.destroy();
    if (upstream) {
      upstream.destroy();
    }
  };

  client.on('error', (error) => {
    process.stderr.write(`[ws-proxy] client error: ${error.message}\n`);
    closeBoth();
  });
  client.on('close', () => {
    if (upstream) {
      upstream.end();
    }
  });

  client.on('data', (chunk) => {
    if (upgraded) {
      if (upstream) {
        upstream.write(chunk);
      }
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const end = parseHeadersEnd(headerBuffer.toString('latin1'));
    if (end < 0) {
      return;
    }

    const text = headerBuffer.toString('latin1');
    const headerText = text.slice(0, end);
    const rest = headerBuffer.subarray(end + 4);
    const rewritten = `${stripPerMessageDeflate(headerText)}\r\n\r\n`;

    upgraded = true;
    upstream = connectTcp({ host: upstreamHost, port: upstreamPort }, () => {
      upstream.write(rewritten, 'latin1');
      if (rest.length > 0) {
        upstream.write(rest);
      }
    });

    upstream.on('data', (data) => {
      client.write(data);
    });
    upstream.on('error', (error) => {
      process.stderr.write(`[ws-proxy] upstream error ${upstreamHost}:${upstreamPort}: ${error.message}\n`);
      closeBoth();
    });
    upstream.on('close', () => {
      client.end();
    });
  });
});

function parseArgs(rawArgs) {
  if (!rawArgs) {
    return [];
  }
  return rawArgs
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function spawnCodexAppServer(port) {
  const listenUri = `ws://${upstreamHost}:${port}`;
  const args = ['app-server', '--listen', listenUri, ...parseArgs(codexArgsExtra)];
  const child = spawn(codexCommand, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (forwardCodexLogs) {
    child.stdout?.on('data', (chunk) => {
      process.stderr.write(`[codex] ${chunk}`);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(`[codex] ${chunk}`);
    });
  }

  child.on('error', (error) => {
    process.stderr.write(`[ws-proxy] failed to start codex: ${error.message}\n`);
    if (!isShuttingDown) {
      shutdown(1);
    }
  });

  child.on('exit', (code, signal) => {
    if (!isShuttingDown) {
      process.stderr.write(
        `[ws-proxy] codex exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`,
      );
      shutdown(1);
    }
  });

  return child;
}

function codexHomeLabel() {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (!codexHome) {
    return '~/.codex/';
  }
  return codexHome.endsWith('/') ? codexHome : `${codexHome}/`;
}

function waitForUpstreamReady(host, port, timeoutMs = 5000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConnect = () => {
      const socket = connectTcp({ host, port });
      let settled = false;

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.once('connect', () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });

      socket.once('error', () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (Date.now() >= deadline) {
          reject(new Error(`codex did not become ready at ws://${host}:${port}`));
          return;
        }
        setTimeout(tryConnect, intervalMs);
      });
    };

    tryConnect();
  });
}

function waitForCodexExit(signal = 'SIGTERM', timeoutMs = 1500) {
  if (!codexProcess || codexProcess.killed || codexProcess.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    };

    codexProcess.once('exit', done);
    codexProcess.kill(signal);

    setTimeout(() => {
      if (finished) {
        return;
      }
      codexProcess?.kill('SIGKILL');
      done();
    }, timeoutMs).unref();
  });
}

async function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  await Promise.all([
    new Promise((resolve) => {
      server.close(() => resolve());
    }),
    waitForCodexExit(),
  ]);
  process.exit(exitCode);
}

async function main() {
  assertPort('WS_PROXY_LISTEN_PORT', listenPortSeed);
  assertPort('WS_PROXY_UPSTREAM_PORT', upstreamPortSeed);
  if (!Number.isInteger(portSearchLimit) || portSearchLimit < 1) {
    throw new Error('WS_PROXY_PORT_SEARCH_LIMIT must be a positive integer');
  }

  const upstreamReservation = await reserveOpenPort(upstreamHost, upstreamPortSeed, portSearchLimit);
  upstreamPort = upstreamReservation.port;
  codexProcess = spawnCodexAppServer(upstreamPort);
  await upstreamReservation.release();
  await waitForUpstreamReady(upstreamHost, upstreamPort);

  const listenPort = await listenWithAutoPort(server, listenHost, listenPortSeed, portSearchLimit);
  startupCompleted = true;
  const listenUri = `ws://${listenHost}:${listenPort}`;

  process.stdout.write('ws-proxy.mjs - WebSocket proxy for Codex app-server\n');
  process.stdout.write(`codex: started (home: ${codexHomeLabel()})\n`);
  process.stdout.write(`listening ${listenUri}\n`);
}

server.on('error', (error) => {
  if (!startupCompleted && error?.code === 'EADDRINUSE') {
    return;
  }
  process.stderr.write(`[ws-proxy] server error: ${error.message}\n`);
  process.exit(1);
});

process.on('SIGINT', () => {
  shutdown(0);
});

process.on('SIGTERM', () => {
  shutdown(0);
});

main().catch((error) => {
  process.stdout.write('ws-proxy.mjs - WebSocket proxy for Codex app-server\n');
  process.stdout.write(`codex: failed to start (home: ${codexHomeLabel()})\n`);
  process.stderr.write(`[ws-proxy] startup failed: ${error.message}\n`);
  shutdown(1);
});
