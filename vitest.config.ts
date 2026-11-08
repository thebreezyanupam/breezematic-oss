import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Pinned so a value in someone's .env cannot move the beat grid under a
    // snapshot. Variables set here count as the shell's, which wins over .env.
    env: {
      MUSIC_BPM: '120',
      LOG_LEVEL: 'error',
    },
  },
});
