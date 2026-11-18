import { useEffect, useState } from 'react';
import { WebRpcClient, type Device } from './rpc';

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let client: WebRpcClient | undefined;
    void WebRpcClient.connect()
      .then(async (connected) => {
        client = connected;
        const result = await connected.call<{ devices: Device[] }>('devices.list', {});
        setDevices(result.devices);
      })
      .catch((reason: unknown) => setError(String(reason)));
    return () => client?.close();
  }, []);

  const booted = devices.filter((device) => device.state === 'booted').length;

  return (
    <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
      <header className="mb-6 flex items-baseline gap-4">
        <h1 className="text-3xl font-bold text-cyan-400">rnctl</h1>
        <span className="text-slate-400">Mission Control</span>
      </header>

      <p className="mb-4 text-slate-400">
        {devices.length} devices · {booted} booted
      </p>

      {error && <p className="mb-4 text-red-400">{error}</p>}

      <ul className="space-y-2">
        {devices.map((device) => (
          <li
            key={device.id}
            className="rounded border border-slate-800 bg-slate-900 px-4 py-2 font-mono text-sm"
          >
            <span className="mr-4 w-16 inline-block text-cyan-300">{device.platform}</span>
            <span className="mr-4 w-20 inline-block text-slate-400">{device.state}</span>
            <span>{device.name}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
