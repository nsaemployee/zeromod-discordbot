const _ = require('lodash')
const Discord = require('discord.js')
const fs = require('fs-jetpack')
const toml = require('toml')

const cp = require('child_process')
const rl = require('readline')

const REGEXES = {
  NETWORK_EVENT: /^(?<op>connect|disconnect): (?<name>.+) \((?<clientid>\d+)\) (?<action>left|joined)$/g,
  MASTER_EVENT: /^master: (?<name>.+) (?<op>claimed|relinquished) (?<privilege>.+)$/g,
  GEOIP_EVENT: /^geoip: client (?<clientid>\d+) connected from (?<location>.+)$/g,
  KICK_EVENT: /^kick: (?<client1>.+) kicked (?<client2>.+)$/g,
  CHAT_EVENT: /^chat: (?<author>.+): (?<message>.+)$/g
}

class DiscordBot {
  constructor () {
    this.config = {}
  }

  async loadConfig () {
    this.config = toml.parse(await fs.readAsync(process.env.ZMDB_CONFIG || 'config.toml'))
  }

  onReady = async () => {
    console.log('Bot logged in.')
    this.channel = await this.Bot.channels.fetch(this.config.channel_id)
  }

  onDiscMessage = (msg) => {
  }

  sendToChannel (...args) {
    console.log('Sending:', args)
    this.channel.send(...args)
  }

  // ClientID -> location
  // only used during GEOIP_EVENT before NETWORK_EVENT
  GEOIP_MAP = new Map()
  onZMDMessage = async (msg) => {
    process.stdout.write(msg + '\n')
    if (!this.channel) {
      return
      // wait till it logs in
    }
    let match

    // most likely comes first
    match = REGEXES.CHAT_EVENT.exec(msg)
    if (match) {
      await this.sendToChannel(`**${match.groups.author}**: ${match.groups.message}`)
      REGEXES.CHAT_EVENT.lastIndex = 0
      return
    }

    // requires special handling
    match = REGEXES.NETWORK_EVENT.exec(msg)
    if (match) {
      const geoloc = this.GEOIP_MAP.get(match.groups.clientid)
      await this.sendToChannel(`**${match.groups.name} (${match.groups.clientid})** ${match.groups.action} ${geoloc ? 'from ' + geoloc : ''}`)
      if (geoloc) {
        this.GEOIP_MAP.delete(match.groups.clientid)
      }
      REGEXES.NETWORK_EVENT.lastIndex = 0
      return
    }

    // also requires special handling
    match = REGEXES.GEOIP_EVENT.exec(msg)
    if (match) {
      this.GEOIP_MAP.set(match.groups.clientid, match.groups.location)
      REGEXES.GEOIP_EVENT.lastIndex = 0
      return
    }

    match = REGEXES.MASTER_EVENT.exec(msg)
    if (match) {
      await this.sendToChannel(`**${match.groups.name}** has ${match.groups.op} ${match.groups.privilege}`)
      REGEXES.MASTER_EVENT.lastIndex = 0
      return
    }

    // TODO also cover ban
    match = REGEXES.KICK_EVENT.exec(msg)
    if (match) {
      await this.sendToChannel(`**${match.groups.client1}** has kicked **${match.groups.client2}**!`)
      REGEXES.KICK_EVENT.lastIndex = 0
    }
  }

  onZMDMessageWrapper = async (...args) => {
    try {
      return await this.onZMDMessage(...args)
    } catch (e) {
      console.log('Arguments:', args)
      console.error('Caught:', e)
    }
  }

  goodbye = () => {
    console.log('It was nice serving you.')
    this.server_process.kill()

    // 3s deadline before SIGKILL is sent
    setTimeout(() => this.server_process.kill('SIGKILL'), 3000)
    this.server_process.on('exit', () => {
      this.Bot.destroy()
      process.exit(0)
    })
  }

  async main () {
    await this.loadConfig()
    if (!_.isString(this.config.discord_token)) {
      console.error('No discord token found in the config, exiting.')
      process.exit(1)
    }

    const isServerArgsInvalid = !_.isUndefined(this.config.server_args) ? !_.isArray(this.config.server_args) : false
    if (!_.isString(this.config.server_executable) || isServerArgsInvalid) {
      console.error('Either 1. server_executable is not a string (see the config), 2. server_args is defined and is not an array (also must be of strings)')
      console.error('Cannot proceed, exiting.')
      process.exit(2)
    }

    if (!_.isString(this.config.channel_id)) {
      console.error('Channel ID not specified in config, exiting.')
      process.exit(3)
    }

    this.Bot = new Discord.Client()
    this.Bot.on('ready', this.onReady)
    this.Bot.on('message', this.onDiscMessage)
    await this.Bot.login(this.config.discord_token)

    // Open the server as a subprocess
    this.server_process = cp.spawn(this.config.server_executable, this.config.server_args, {
      cwd: this.config.server_cwd || undefined,
      stdio: 'pipe'
    })
    // good ol' crossover
    this.rlInterface = rl.createInterface({
      input: this.server_process.stdout,
      output: this.server_process.stdin,
      terminal: false
    })

    this.rlInterface.on('line', this.onZMDMessage)
    process.stdin.on('data', (data) => {
      this.server_process.stdin.write(data)
    })

    process.on('SIGINT', this.goodbye)
    process.on('SIGTERM', this.goodbye)
  }
}

const db = new DiscordBot()
db.main()
