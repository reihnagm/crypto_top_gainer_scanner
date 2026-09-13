module.exports = {
  apps: [
    {
      name: "crypto-top-gainer-scanner",
      script: "src/index.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
