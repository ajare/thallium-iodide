import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
for (const file of ['index.html', 'style.css', 'logo.png']) await copyFile(`web/${file}`, `dist/public/${file}`);
