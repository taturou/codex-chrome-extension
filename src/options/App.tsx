import { useEffect, useState } from 'react';
import type { SettingsResult } from '../contracts/messages';
import { sendCommand } from '../shared/runtime';

export function App(): JSX.Element {
  const [wsUrl, setWsUrl] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void (async () => {
      const res = await sendCommand<SettingsResult>({ type: 'GET_SETTINGS', payload: {} });
      setWsUrl(res.settings.wsUrl);
    })();
  }, []);

  async function save(): Promise<void> {
    await sendCommand({ type: 'SAVE_SETTINGS', payload: { wsUrl } });
    setNotice('保存しました');
  }

  async function connect(): Promise<void> {
    await sendCommand({ type: 'CONNECT_WS', payload: { url: wsUrl } });
    setNotice('接続要求を送信しました');
  }

  async function disconnect(): Promise<void> {
    await sendCommand({ type: 'DISCONNECT_WS', payload: {} });
    setNotice('切断要求を送信しました');
  }

  return (
    <main className="page">
      <h1>設定</h1>
      <div className="row">
        <label htmlFor="ws-url">WebSocket URL</label>
        <input
          id="ws-url"
          value={wsUrl}
          onChange={(event) => setWsUrl(event.target.value)}
          placeholder="ws://localhost:3000"
        />
      </div>
      <div className="actions">
        <button type="button" onClick={() => void save()}>
          保存
        </button>
        <button type="button" onClick={() => void connect()}>
          接続
        </button>
        <button type="button" onClick={() => void disconnect()}>
          切断
        </button>
      </div>
      {notice ? <p>{notice}</p> : null}
    </main>
  );
}
