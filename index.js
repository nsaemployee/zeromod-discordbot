const _ = require('lodash')
const Discord = require('discord.js')
const fs = require('fs-jetpack')
const toml = require('toml')

class DiscordBot {
  constructor () {
    this.config = {}
  }

  async loadConfig () {
    this.config = toml.parse(await fs.readAsync(process.env.ZMDB_CONFIG || 'config.toml'))
  }

  onReady = () => {
    console.log('Bot logged in.')
  }

  onMessage = (msg) => {

  }

  async main () {
    await this.loadConfig()
    if (!_.isString(this.config.discord_token)) {
      console.error('No discord token found in the config, exiting.')
      process.exit(1)
    }

    this.Bot = new Discord.Client()
    this.Bot.on('ready', this.onReady)
    this.Bot.on('message', this.onMessage)
    await this.Bot.login(this.config.discord_token)
  }
}

const db = new DiscordBot()
db.main()
