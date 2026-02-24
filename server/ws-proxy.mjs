import { createServer, connect as connectTcp } from 'node:net';

const listenHost = process.env.WS_PROXY_LISTEN_HOST ?? '127.0.0.1';
const listenPortSeed = Number(process.env.WS_PROXY_LISTEN_PORT ?? '43172');
const portSearchLimit = Number(process.env.WS_PROXY_PORT_SEARCH_LIMIT ?? '200');
const upstreamHost = process.env.WS_PROXY_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.WS_PROXY_UPSTREAM_PORT ?? '43171');

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

function listenOnce(server, host, port) {
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
    server.listen(port, host);
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

const server = createServer((client) => {
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

async function main() {
  assertPort('WS_PROXY_LISTEN_PORT', listenPortSeed);
  assertPort('WS_PROXY_UPSTREAM_PORT', upstreamPort);
  if (!Number.isInteger(portSearchLimit) || portSearchLimit < 1) {
    throw new Error('WS_PROXY_PORT_SEARCH_LIMIT must be a positive integer');
  }

  const listenPort = await listenWithAutoPort(server, listenHost, listenPortSeed, portSearchLimit);
  startupCompleted = true;
  const listenUri = `ws://${listenHost}:${listenPort}`;
  const upstreamUri = `ws://${upstreamHost}:${upstreamPort}`;

  process.stdout.write(`WS_PROXY_URI=${listenUri}\n`);
  process.stdout.write(`ws-proxy listening ${listenUri} -> ${upstreamUri}\n`);
}

let startupCompleted = false;
server.on('error', (error) => {
  if (!startupCompleted && error?.code === 'EADDRINUSE') {
    return;
  }
  process.stderr.write(`[ws-proxy] server error: ${error.message}\n`);
  process.exit(1);
});

main().catch((error) => {
  process.stderr.write(`[ws-proxy] startup failed: ${error.message}\n`);
  process.exit(1);
});
