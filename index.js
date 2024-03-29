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

const REGEXES = {
  NETWORK_EVENT: /^(?<op>connect|disconnect): (?<name>[^ ]+) \((?<clientid>\d+)\) (?<action>left|joined)$/g,
  MASTER_EVENT: /^master: (?<name>.+) (?<op>claimed|relinquished) (?<privilege>.+)$/g,
  GEOIP_EVENT: /^geoip: client (?<clientid>\d+) connected from (?<location>.+)$/g,
  KICK_EVENT: /^kick: (?<client1>.+) kicked (?<client2>.+)$/g,
  CHAT_EVENT: /^chat: (?<author>[^ ]+? \(\d+\)): (?<message>.+)$/g,
  RENAME_EVENT: /^rename: (?<oldname>.+) \((\d+)\) is now known as (?<newname>.+)$/g,
  // eslint-disable-next-line no-useless-escape
  DISCORD_DIRTY_TEXT_REGEX: /[.\[\]"'\\]/gi,
  DISCORD_PURE_TEXT_REGEX: /[\u0021-\u002f\u005b-\u0060\u007b-\u007e]/gi,
  // REMOVE_SLASH_REGEX: /\//gi
  SAUER_DIRTY_TEXT_REGEX: /["^]/gi
}

/* eslint no-extend-native: ["error", { "exceptions": ["RegExp"] }] */
RegExp.prototype.execAndClear = function (input) {
  const resp = this.exec(input)
  this.lastIndex = 0
  return resp
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

    const relevantHooks = (await this.channel.fetchWebhooks()).filter(hook => {
      return hook.name === 'ZMDB_HOOK'
    })
    if (relevantHooks.size > 1) {
      this.webhook = relevantHooks.first()
    } else {
      this.webhook = await this.channel.createWebhook('ZMDB_HOOK')
    }
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

  escapeWithSlash (match) {
    return '\\' + match
  }

  escapeWithCircumflex (match) {
    return '^' + match
  }

  onDiscMessage = async (msg) => {
    if (msg.channel.id !== this.config.channel_id || msg.author.id === this.Bot.user.id || msg.webhookID === this.webhook.id) {
      return
    }

    // Translate to s_talkbot_fakesay and get it over with
    const lines = msg.cleanContent.split('\n')
    let username = _.get(msg, ['member', 'displayName'], false) || msg.author.name || msg.author.username
    if (username != null) {
      username = username.replace(REGEXES.SAUER_DIRTY_TEXT_REGEX, this.escapeWithCircumflex)
    } else {
      username = '?!?!?'
    }

    const cmdData = `s_talkbot_fakesay 0 "_" "[${username}]" `

    // TODO make it safer?
    /*
    if (username.indexOf(' ') === -1) {
      cmdData = `s_talkbot_fakesay 0 "${username}" `
    } else {
      cmdData = `s_talkbot_say "" "[${username}]:" `
    }
    */

    for (const line of lines) {
      const generatedMsg = cmdData + '"' + line.replace(REGEXES.SAUER_DIRTY_TEXT_REGEX, this.escapeWithCircumflex) + '"\n'
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

  suffixServerName (uname) {
    return uname + ' @ ' + this.Bot.user.username
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
    match = REGEXES.CHAT_EVENT.execAndClear(msg)
    if (match) {
      const cleanedText = match.groups.message.replace(REGEXES.DISCORD_DIRTY_TEXT_REGEX, this.escapeWithSlash)
      await this.webhook.send(cleanedText, {
        username: this.suffixServerName(match.groups.author)
      })
      return
    }

    // requires special handling
    match = REGEXES.NETWORK_EVENT.execAndClear(msg)
    if (match) {
      const geoloc = this.GEOIP_MAP.get(match.groups.clientid)
      await this.webhook.send(`${match.groups.action} ${geoloc ? 'from ' + geoloc : ''}`, {
        username: this.suffixServerName(`${match.groups.name} (${match.groups.clientid})`)
      })
      if (geoloc) {
        this.GEOIP_MAP.delete(match.groups.clientid)
      }
      return
    }

    // also requires special handling
    match = REGEXES.GEOIP_EVENT.execAndClear(msg)
    if (match) {
      this.GEOIP_MAP.set(match.groups.clientid, match.groups.location)
      return
    }

    match = REGEXES.MASTER_EVENT.execAndClear(msg)
    if (match) {
      await this.webhook.send(`has ${match.groups.op} ${match.groups.privilege}`, {
        username: this.suffixServerName(match.groups.name)
      })
      return
    }

    match = REGEXES.RENAME_EVENT.execAndClear(msg)
    if (match) {
      await this.webhook.send(`is now known as ${match.groups.newname.replace(REGEXES.DISCORD_EXTRA_DIRTY_TEXT_REGEX, this.escapeWithSlash)}`, {
        username: this.suffixServerName(match.groups.oldname)
      })
      return
    }

    // TODO also cover ban
    match = REGEXES.KICK_EVENT.execAndClear(msg)
    if (match) {
      await this.webhook.send(`has kicked **${match.groups.client2}**!`, {
        username: this.suffixServerName(match.groups.client1)
      })
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

    if (this.config.escape_all_sauer_input) {
      REGEXES.DISCORD_DIRTY_TEXT_REGEX = REGEXES.DISCORD_PURE_TEXT_REGEX
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
      output: null,
      terminal: false
    })

    this.rlInterface.on('line', this.onZMDMessageWrapper)
    process.stdin.on('data', (data) => {
      this.writeToSP(data).catch(e => console.error(e))
    })

    process.on('SIGINT', this.goodbye)
    process.on('SIGTERM', this.goodbye)
  }
}

const db = new DiscordBot()
db.main()
