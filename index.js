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
const fs = require('fs-jetpack')
const toml = require('toml')
const IRC = require('irc-framework')
const fastq = require('fastq')

const cp = require('child_process')
const rl = require('readline')

const REGEXES = {
  IRC_NICK: /(?<ircnick>[a-zA-Z\[\]\\`_\^\{\|\}][a-zA-Z0-9\[\]\\`_\^\{\|\}-]{1,31})/gi,
  CONNECT_EVENT: /^connect: (?<name>[^ ]+) \((?<clientid>\d+)\) joined$/g,
  DISCONNECT_EVENT: /^disconnect: (?<name>[^ ]+) \((?<clientid>\d+)\) left$/g,
  MASTER_EVENT: /^master: (?<name>.+) (?<op>claimed|relinquished) (?<privilege>.+)$/g,
  GEOIP_EVENT: /^geoip: client (?<clientid>\d+) connected from (?<location>.+)$/g,
  KICK_EVENT: /^kick: (?<client1>.+) kicked (?<client2>.+)$/g,
  CHAT_EVENT: /^chat: (?<author>[^ ]+?) \((?<clientid>\d+)\): (?<message>.+)$/g,
  RENAME_EVENT: /^rename: (?<oldname>.+) \((?<clientid>\d+)\) is now known as (?<newname>.+)$/g,
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

const JOB_TYPES = {
  CHAT: 1,
  CONNECT: 2,
  DISCONNECT: 3,
  GEOIP: 4,
  MASTER: 5,
  RENAME: 6,
  KICK: 7
}

class DiscordBot {
  config = {}
  async loadConfig () {
    this.config = toml.parse(await fs.readAsync(process.env.ZMDB_CONFIG || 'config.toml'))
  }

  onIRCRegister = async () => {
    this.Bot.join(this.config.channel)
    this.masterChannel = this.Bot.channel(this.config.channel)
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

  ircInstances = new Map()
  ownedNicks = new Set()
  onIRCQueueJob = async ({ type, match }) => {
    switch (type) {
      case JOB_TYPES.CHAT: {
        const instance = this.ircInstances.get(match.groups.clientid)
        // probably connecting
        if (!instance) {
          return
        }
        instance._channel.say(match.groups.message)
        break
      }
      case JOB_TYPES.CONNECT: {
        const geoloc = this.GEOIP_MAP.get(match.groups.clientid)
        const userInstance = new IRC.Client()
        const channel = userInstance.channel(this.config.channel)
        const nickMatch = REGEXES.IRC_NICK.execAndClear(match.groups.name)
        userInstance._channel = channel

        userInstance.on('registered', () => {
          userInstance.join(this.config.channel)
        })
        if (geoloc) {
          userInstance.on('join', (e) => {
            if (e.nick !== userInstance.user.nick) {
              return
            }
            channel.say('Connected from: ' + geoloc)
          })
          this.GEOIP_MAP.delete(match.groups.clientid)
        }

        await userInstance.connect({
          ...this.config.irc,
          nick: nickMatch.groups.ircnick
        })
        userInstance.on('nick in use', (ev) => {
          this.queue.push({
            type: JOB_TYPES.RENAME,
            match: {
              groups: {
                clientid: match.groups.clientid,
                newname: ev.nick + '_'
              }
            }
          })
        })

        this.ircInstances.set(match.groups.clientid, userInstance)
        this.ownedNicks.add(nickMatch.groups.ircnick)
        break
      }
      case JOB_TYPES.DISCONNECT: {
        const { clientid } = match.groups
        const instance = this.ircInstances.get(clientid)
        this.ownedNicks.delete(instance.user.nick)
        instance.connection.end(null, false)
        break
      }
      case JOB_TYPES.GEOIP:
        this.GEOIP_MAP.set(match.groups.clientid, match.groups.location)
        break
      case JOB_TYPES.MASTER:
        this.masterChannel.say(`${match.groups.name} has ${match.groups.op} ${match.groups.privilege}!`)
        break
      case JOB_TYPES.RENAME: {
        const instance = this.ircInstances.get(match.groups.clientid)
        this.ownedNicks.delete(instance.user.nick)
        instance.changeNick(match.groups.newname)
        this.ownedNicks.add(match.groups.newname)
        break
      }
      case JOB_TYPES.KICK:
        this.masterChannel.say(`${match.groups.client1} has kicked ${match.groups.client2}!`)
        break
    }
  }

  queue = fastq.promise(this.onIRCQueueJob, 1)

  onIRCMessage = async (msg) => {
    if (msg.target !== this.config.channel || msg.nick === this.Bot.user.nick || this.ownedNicks.has(msg.nick)) {
      return
    }

    let username = msg.nick
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
    // Translate to s_talkbot_fakesay and get it over with
    const generatedMsg = cmdData + '"' + msg.message.replace(REGEXES.SAUER_DIRTY_TEXT_REGEX, this.escapeWithCircumflex) + '"\n'
    await this.writeToStdout(generatedMsg)
    await this.writeToSP(generatedMsg)
  }

  // ClientID -> location
  // only used during GEOIP_EVENT before NETWORK_EVENT
  GEOIP_MAP = new Map()
  onZMDMessage = async (msg) => {
    await this.writeToStdout(msg + '\n')
    if (!this.masterChannel) {
      return
      // wait till it logs in
    }
    let match

    // most likely comes first
    match = REGEXES.CHAT_EVENT.execAndClear(msg)
    if (match) {
      await this.queue.push({
        type: JOB_TYPES.CHAT,
        match
      })
      return
    }

    // requires special handling
    match = REGEXES.CONNECT_EVENT.execAndClear(msg)
    if (match) {
      await this.queue.push({
        type: JOB_TYPES.CONNECT,
        match
      })
      return
    }

    match = REGEXES.DISCONNECT_EVENT.execAndClear(msg)
    if (match) {
      await this.queue.push({
        type: JOB_TYPES.DISCONNECT,
        match
      })
    }

    // also requires special handling
    match = REGEXES.GEOIP_EVENT.execAndClear(msg)
    if (match) {
      // Don't need to necessarily synchronize this
      await this.queue.push({
        type: JOB_TYPES.GEOIP,
        match
      })
      return
    }

    match = REGEXES.MASTER_EVENT.execAndClear(msg)
    if (match) {
      await this.queue.push({
        type: JOB_TYPES.MASTER,
        match
      })
      return
    }

    match = REGEXES.RENAME_EVENT.execAndClear(msg)
    if (match) {
      await this.queue.push({
        type: JOB_TYPES.RENAME,
        match
      })
      return
    }

    // TODO also cover ban
    match = REGEXES.KICK_EVENT.execAndClear(msg)
    if (match) {
      await this.queue.push({
        type: JOB_TYPES.KICK,
        match
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
      for (const instance of this.ircInstances.values()) {
        instance.connection.end(null, false)
      }
      this.Bot.connection.end(null, false)
      process.exit(0)
    })
  }

  async main () {
    await this.loadConfig()

    const isServerArgsInvalid = !_.isUndefined(this.config.server_args) ? !_.isArray(this.config.server_args) : false
    if (!_.isString(this.config.server_executable) || isServerArgsInvalid) {
      console.error('Either 1. server_executable is not a string (see the config), 2. server_args is defined and is not an array (also must be of strings)')
      console.error('Cannot proceed, exiting.')
      process.exit(2)
    }

    if (!_.isString(this.config.channel)) {
      console.error('Channel ID not specified in config, exiting.')
      process.exit(3)
    }

    if (this.config.escape_all_sauer_input) {
      REGEXES.DISCORD_DIRTY_TEXT_REGEX = REGEXES.DISCORD_PURE_TEXT_REGEX
    }

    this.Bot = new IRC.Client()
    this.Bot.on('registered', this.onIRCRegister)
    this.Bot.on('privmsg', this.onIRCMessage)
    this.Bot.on('nick in use', (ev) => {
      this.Bot.changeNick(ev.nick + '_')
    })
    await this.Bot.connect(this.config.irc)

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
