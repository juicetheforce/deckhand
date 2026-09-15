#!/usr/bin/env node
/**
 * A stand-in for pactl, for offline tests: put its directory first on PATH
 * under the name "pactl". It answers the read-only calls the audio cache
 * makes (`-f json info`, `-f json list sinks`, `-f json list sources`) with
 * made-up devices that cover every case the device lists must handle, and
 * `subscribe` by staying silent. Each invocation is appended to the file
 * named by FAKE_PACTL_LOG, so a test can count spawns.
 *
 * The JSON shape follows real `pactl -f json` output (pactl 17.0); the device
 * names are invented, not anyone's hardware.
 */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_PACTL_LOG) appendFileSync(process.env.FAKE_PACTL_LOG, args.join(' ') + '\n');

const port = (name, availability) => ({ name, description: name, type: 'Unknown', priority: 1, availability_group: '', availability });

const sinks = [
  // A local device with an available port.
  { index: 1, name: 'alsa_output.usb-Example_Headset-00.analog-stereo', description: 'Example Headset Analog Stereo', flags: ['HARDWARE', 'DECIBEL_VOLUME', 'LATENCY'], monitor_source: 'alsa_output.usb-Example_Headset-00.analog-stereo.monitor', ports: [port('analog-output', 'available')], active_port: 'analog-output', mute: false, volume: { 'front-left': { value_percent: '40%' } } },
  // The same device's mono sink: both are listed; choosing between them is the user's call.
  { index: 2, name: 'alsa_output.usb-Example_Headset-00.mono-chat', description: 'Example Headset Mono', flags: ['HARDWARE'], monitor_source: 'alsa_output.usb-Example_Headset-00.mono-chat.monitor', ports: [port('mono-output', 'availability unknown')], active_port: 'mono-output', mute: false },
  // A jack with nothing plugged in: listed, marked unavailable.
  { index: 3, name: 'alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink', description: 'Built-in Headphones', flags: ['HARDWARE'], monitor_source: 'alsa_output.pci-0000_00_1f.3.HiFi__Headphones__sink.monitor', ports: [port('[Out] Headphones', 'not available')], active_port: '[Out] Headphones', mute: false },
  // A local device whose description pactl's JSON mangled: label falls back to the node name.
  { index: 4, name: 'alsa_output.usb-Accented_Device-00.analog-stereo', description: '(null)', flags: ['HARDWARE'], monitor_source: 'alsa_output.usb-Accented_Device-00.analog-stereo.monitor', ports: [port('out', 'available')], active_port: 'out', mute: false },
  // A network sink: left out.
  { index: 5, name: 'raop_sink.Example-Speaker.local.192.0.2.10.7000', description: 'Kitchen Speaker', flags: ['NETWORK', 'DECIBEL_VOLUME', 'LATENCY'], monitor_source: 'raop_sink.Example-Speaker.local.192.0.2.10.7000.monitor', ports: [], active_port: null, mute: false },
];

const sources = [
  // Monitors of every sink: left out of the source list.
  ...sinks.map((s, i) => ({ index: 100 + i, name: `${s.name}.monitor`, description: `Monitor of ${s.description}`, flags: s.flags, monitor_source: s.name, ports: [], active_port: null, mute: false })),
  // Real inputs.
  { index: 200, name: 'alsa_input.usb-Example_Headset-00.mono-fallback', description: 'Example Headset Mono Mic', flags: ['HARDWARE', 'HW_MUTE_CTRL'], monitor_source: '', ports: [port('analog-input-mic', 'availability unknown')], active_port: 'analog-input-mic', mute: true },
  { index: 201, name: 'alsa_input.pci-0000_00_1f.3.HiFi__Mic__source', description: 'Built-in Microphone', flags: ['HARDWARE'], monitor_source: '', ports: [port('[In] Mic', 'available')], active_port: '[In] Mic', mute: false },
  // An input with no ports at all.
  { index: 202, name: 'alsa_input.virtual-portless', description: 'Portless Input', flags: ['HARDWARE'], monitor_source: '', ports: [], active_port: null, mute: false },
];

const info = { default_sink_name: sinks[0].name, default_source_name: sources.at(-3).name };

const joined = args.join(' ');
if (joined === '-f json info') process.stdout.write(JSON.stringify(info));
else if (joined === '-f json list sinks') process.stdout.write(JSON.stringify(sinks));
else if (joined === '-f json list sources') process.stdout.write(JSON.stringify(sources));
else if (joined === 'subscribe') setInterval(() => undefined, 1 << 30);
else if (joined === 'get-default-sink') process.stdout.write(info.default_sink_name + '\n');
else {
  process.stderr.write(`fake-pactl: unsupported: ${joined}\n`);
  process.exit(1);
}
