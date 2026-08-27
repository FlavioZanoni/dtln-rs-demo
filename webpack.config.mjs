import { merge } from 'webpack-merge';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const common = {
  mode: process.env.NODE_ENV ?? "development",

  resolveLoader: {
    modules: ["node_modules"],
  },

  resolve: {
    extensions: [".ts", ".js"],
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: ["swc-loader"],
        exclude: [/node_modules/, /dist/],
      },
    ],
  },
};

const pages = merge(common, {
  target: 'web',
  entry: {
    app: "./src/app.js",   // the lab: spectrograms, live monitor, A/B record
    test: "./src/test.js", // the self-check
  },
  output: {
    filename: "[name].js",
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: "./index.html", to: "./" },
        { from: "./check.html", to: "./" },
      ],
    }),
  ],
});

const audioWorklet = merge(common, {
  target: "webworker",
  entry: "./src/audio-worklet/main.ts",
  output: {
    filename: "audio-worklet.js",
  },
});

export default [
  pages,
  audioWorklet,
];
