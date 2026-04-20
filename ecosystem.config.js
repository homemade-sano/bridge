module.exports = {
  apps: [
    {
      name: "bridge",
      script: "dist/server.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
    },
    {
      name: "bridge-tray",
      script: "dist/tray.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
    },
  ],
};
