# zeromod-discordbot

A better zeromod to discord integration, written in Node.js.

## Features

1. Gracefully handles attachments (advantage over the unnamed competitor)
2. Fully two-way.
3. Truly asynchronous. (advantage over the unnamed competitor)
4. Runs zeromod by itself as a child process so you don't have to fuck with FIFOs.
5. Will gracefully copy all child process stdio to stdio so you don't need to change any logging scripting you had.

## How to use?

```shell
cp config.toml.example config.toml
$EDITOR config.toml
yarn install
node index.js
```

You can also use `npm` in place of `yarn` if you don't want to install `npm` like:

`npm install`

## TODO

1. Webhook integration in the near future
2. In certain cases allow Discord usernames to be used as in game usernames.
