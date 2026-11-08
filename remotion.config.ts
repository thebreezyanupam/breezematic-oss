import { Config } from '@remotion/cli/config';
import { webpackOverride } from './src/remotion/webpack';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig(webpackOverride);
