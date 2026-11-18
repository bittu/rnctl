import { RpcClient } from '@rnctl/core';
import type { DeviceInfo } from '@rnctl/sdk';
import { Box, Text, render } from 'ink';
import { createElement, useEffect, useState } from 'react';

function Dashboard({ client }: { client: RpcClient }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void client.call<{ devices: DeviceInfo[] }>('devices.list')
      .then((result) => { if (active) setDevices(result.devices); })
      .catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [client]);

  const booted = devices.filter((device) => device.state === 'booted').length;
  return createElement(
    Box,
    { flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: 'cyan' }, 'rnctl - Mission Control'),
    createElement(Text, null, `Devices: ${devices.length} (${booted} booted)`),
    ...devices.slice(0, 12).map((device) => createElement(
      Text,
      { key: device.id },
      `  ${device.platform.padEnd(7)} ${device.state.padEnd(8)} ${device.name}`,
    )),
    error ? createElement(Text, { color: 'red' }, error) : null,
    createElement(Text, { dimColor: true }, 'Press Ctrl+C to quit.'),
  );
}

export async function renderDashboard(client?: RpcClient): Promise<void> {
  const rpc = client ?? await RpcClient.connect();
  const instance = render(createElement(Dashboard, { client: rpc }));
  await instance.waitUntilExit();
  rpc.close();
}
