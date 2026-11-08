import type { WebpackOverrideFn } from '@remotion/bundler';

export const webpackOverride: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: {
      '.js': ['.tsx', '.ts', '.js'],
      ...(config.resolve?.extensionAlias ?? {}),
    },
  },
  module: {
    ...config.module,
    rules: [
      ...(config.module?.rules ?? []),
      // Inline the font as a data URI. Fetching it over the bundle's dev server
      // hung delayRender() on pages Remotion opened part-way through a render.
      { test: /\.woff2$/, type: 'asset/inline' },
    ],
  },
});
