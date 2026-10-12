import { defineConfig, mergeConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import base from './vite.config';

// LAN preview: WebGPU needs a secure context, so serve https with a self-signed certificate.
export default mergeConfig(base, defineConfig({ plugins: [basicSsl()], server: { host: true } }));
