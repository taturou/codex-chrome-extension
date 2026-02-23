import { createServer, connect as connectTcp } from 'node:net';

const listenHost = process.env.WS_PROXY_LISTEN_HOST ?? '127.0.0.1';
const listenPort = Number(process.env.WS_PROXY_LISTEN_PORT ?? '43172');
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

  client.on('error', closeBoth);
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

    upstream = connectTcp({ host: upstreamHost, port: upstreamPort }, () => {
      upstream.write(rewritten, 'latin1');
      if (rest.length > 0) {
        upstream.write(rest);
      }
      upgraded = true;
    });

    upstream.on('data', (data) => {
      client.write(data);
    });
    upstream.on('error', closeBoth);
    upstream.on('close', () => {
      client.end();
    });
  });
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(
    `ws-proxy listening ws://${listenHost}:${listenPort} -> ws://${upstreamHost}:${upstreamPort}\n`
  );
});
