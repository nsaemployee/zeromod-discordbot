/*
    A Zeromod to Discord integration
    Copyright (C) 2020 John W Doe

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const _ = require('lodash')
const Discord = require('discord.js')
const fs = require('fs-jetpack')
const toml = require('toml')

const cp = require('child_process')
const rl = require('readline')
const { promisify } = require('util')
const nfs = require('fs')

const REGEXES = {
  NETWORK_EVENT: /^(?<op>connect|disconnect): (?<name>.+) \((?<clientid>\d+)\) (?<action>left|joined)$/g,
  MASTER_EVENT: /^master: (?<name>.+) (?<op>claimed|relinquished) (?<privilege>.+)$/g,
  GEOIP_EVENT: /^geoip: client (?<clientid>\d+) connected from (?<location>.+)$/g,
  KICK_EVENT: /^kick: (?<client1>.+) kicked (?<client2>.+)$/g,
  CHAT_EVENT: /^chat: (?<author>.+): (?<message>.+)$/g,
  // eslint-disable-next-line no-useless-escape
  DISCORD_DIRTY_TEXT_REGEX: /[.\[\]"'\\]/gi,
  // REMOVE_SLASH_REGEX: /\//gi
  SAUER_DIRTY_TEXT_REGEX: /["^]/gi
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

  writeToSP (data) {
    return new Promise(resolve => {
      return this.server_process.stdin.write(data, resolve)
    })
  }

  writeToStdout (data) {
    return new Promise(resolve => {
      return process.stdout.write(data, resolve)
    })
  }

  escapeStr (match) {
    return ''
  }

  onDiscMessage = async (msg) => {
    if (msg.channel.id !== this.config.channel_id || msg.author.id === this.Bot.user.id) {
      return
    }

    // Translate to s_talkbot_say and get it over with
    const lines = msg.cleanContent.split('\n')

    const username = (_.get(msg, ['member', 'displayName']) || msg.author.name).replace(REGEXES.SAUER_DIRTY_TEXT_REGEX, this.escapeStr)
    let cmdData = ''

    // TODO make it safer?
    if (username.indexOf(' ') === -1) {
      cmdData = `s_talkbot_fakesay 0 "${username}" `
    } else {
      cmdData = `s_talkbot_say "" "[${username}]:" `
    }

    for (const line of lines) {
      const generatedMsg = cmdData + '"' + line.replace(REGEXES.SAUER_DIRTY_TEXT_REGEX, this.escapeStr) + '"\n'
      REGEXES.SAUER_DIRTY_TEXT_REGEX.lastIndex = 0
      await this.writeToStdout(generatedMsg)
      await this.writeToSP(generatedMsg)
    }

    for (const it of msg.attachments) {
      const attachment = it[1]
      const generatedMsg = cmdData + `"has uploaded the file ${attachment.name}: ${attachment.url}"\n`
      await this.writeToStdout(generatedMsg)
      await this.writeToSP(generatedMsg)
    }
  }

  // ClientID -> location
  // only used during GEOIP_EVENT before NETWORK_EVENT
  GEOIP_MAP = new Map()
  onZMDMessage = async (msg) => {
    await this.writeToStdout(msg + '\n')
    if (!this.channel) {
      return
      // wait till it logs in
    }
    let match

    // most likely comes first
    match = REGEXES.CHAT_EVENT.exec(msg)
    if (match) {
      const cleanedText = match.groups.message.replace(REGEXES.DISCORD_DIRTY_TEXT_REGEX, this.escapeStr)
      REGEXES.DISCORD_DIRTY_TEXT_REGEX.lastIndex = 0

      await this.channel.send(`**${match.groups.author}**: ${cleanedText}`)
      REGEXES.CHAT_EVENT.lastIndex = 0
      return
    }

    // requires special handling
    match = REGEXES.NETWORK_EVENT.exec(msg)
    if (match) {
      const geoloc = this.GEOIP_MAP.get(match.groups.clientid)
      await this.channel.send(`**${match.groups.name} (${match.groups.clientid})** ${match.groups.action} ${geoloc ? 'from ' + geoloc : ''}`)
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
      await this.channel.send(`**${match.groups.name}** has ${match.groups.op} ${match.groups.privilege}`)
      REGEXES.MASTER_EVENT.lastIndex = 0
      return
    }

    // TODO also cover ban
    match = REGEXES.KICK_EVENT.exec(msg)
    if (match) {
      await this.channel.send(`**${match.groups.client1}** has kicked **${match.groups.client2}**!`)
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

    if (!_.isString(this.config.channel_id)) {
      console.error('Channel ID not specified in config, exiting.')
      process.exit(3)
    }

    // Setup some hooks
    process.stdin.on('data', (data) => {
      console.log('Data:', data)
      this.writeToStdout(data)
    })

    process.on('SIGINT', this.goodbye)
    process.on('SIGTERM', this.goodbye)

    this.Bot = new Discord.Client()
    this.Bot.on('ready', this.onReady)
    this.Bot.on('message', this.onDiscMessage)
    await this.Bot.login(this.config.discord_token)

    if (this.config.fifomode === true) {
      const openAsync = promisify(nfs.open)
      try {
        this.server_process = {
          stdin: await openAsync(this.config.stdin_fifo, 'r'),
          stdout: await openAsync(this.config.stdout_fifo, 'a'),

          kill () {},
          on (_, fn) {
            fn()
          }
        }
      } catch (e) {
        console.error('Caught:', e)
        process.exit(4)
      }
    } else {
      const isServerArgsInvalid = !_.isUndefined(this.config.server_args) ? !_.isArray(this.config.server_args) : false
      if (!_.isString(this.config.server_executable) || isServerArgsInvalid) {
        console.error('Either 1. server_executable is not a string (see the config), 2. server_args is defined and is not an array (also must be of strings)')
        console.error('Cannot proceed, exiting.')
        process.exit(2)
      }

      // Open the server as a subprocess
      this.server_process = cp.spawn(this.config.server_executable, this.config.server_args, {
        cwd: this.config.server_cwd || undefined,
        stdio: 'pipe'
      })
    }
    // good ol' crossover
    this.rlInterface = rl.createInterface({
      input: this.server_process.stdout,
      output: null,
      terminal: false
    })

    this.rlInterface.on('line', this.onZMDMessageWrapper)
  }
}

const db = new DiscordBot()
db.main()
