const { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } = require('baileys')
const { makeWASocket } = require('baileys')
const qrcode = require('qrcode-terminal')
const P = require('pino')

// In-memory game storage
const games = new Map() // groupId -> currentGame
const gameHistory = []

// Game structure
class VolleyballGame {
  constructor(groupId, dateTime, format, courts, maxPlayers) {
    this.id = Date.now().toString()
    this.groupId = groupId
    this.dateTime = dateTime
    this.format = format
    this.courts = courts
    this.maxPlayers = maxPlayers
    this.players = []
    this.status = 'active' // 'active' | 'payment' | 'closed'
    this.pixKey = ''
    this.totalAmount = 0
    this.amountPerPlayer = 0
  }
}

// const groupCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const ALLOWED_GROUPS = new Set([
  '120363402238638238@g.us', // test group ID
  'changeme@g.us' // Your volleyball group ID
])

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` })
logger.level = 'trace'

// WhatsApp connection
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  const sock = makeWASocket({
    logger: logger,
    printQRInTerminal: true,
    auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
    // browser: Browsers.macOS('Desktop')
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== 401
      console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect)
      if (shouldReconnect) {
        connectToWhatsApp()
      }
    } else if (connection === 'open') {
      console.log('opened connection')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const text = msg.message.conversation || (msg.message.extendedTextMessage?.text || '')
    const sender = msg.key.remoteJid
    const isGroup = sender.endsWith('@g.us')
    const user = msg.key.participant || sender

    if (isGroup && !ALLOWED_GROUPS.has(sender)) return  // Only work in groups allowed

    console.log('recebido msg de do grupo permitido', sender, msg)

    try {
      if (text.startsWith('!')) {
        const command = text.split(' ')[0].substring(1).toLowerCase()
        const args = text.split(' ').slice(1)

        // Get group metadata to check if sender is admin
        const metadata = await sock.groupMetadata(sender)
        const userMetadata = metadata.participants.find(p => p.id === user)
        const isAdmin = userMetadata.admin === 'admin' || userMetadata.admin === 'superadmin'

        console.log('isAdmin', isAdmin, userMetadata)

        // Get current game for this group
        let currentGame = games.get(sender)

        switch (command) {
          case 'creategame':
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ Apenas administradores podem criar jogos!' })
              return
            }
            
            if (currentGame && currentGame.status !== 'closed') {
              await sock.sendMessage(sender, { text: '❌ Já existe um jogo ativo neste grupo!' })
              return
            }
            
            if (args.length < 4) {
              await sock.sendMessage(sender, { text: '❌ Formato incorreto. Use: !createGame [data/hora] [formato](3x3, 4x4) [quadras] (2, 3) [jogadores](18, 20)' })
              return
            }

            currentGame = new VolleyballGame(sender, args[0], args[1], parseInt(args[2]), parseInt(args[3]))
            games.set(sender, currentGame)
            await sendGameList(sock, sender, currentGame)
            break

          case 'enablepayment':
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ Apenas administradores podem habilitar pagamentos!' })
              return
            }
            
            if (!currentGame || currentGame.status !== 'active') {
              await sock.sendMessage(sender, { text: '❌ Nenhum jogo ativo para habilitar pagamentos' })
              return
            }

            if (args.length < 2) {
              await sock.sendMessage(sender, { text: '❌ Formato incorreto. Use: !enablePayment [chavePIX] [valorTotal]' })
              return
            }

            currentGame.pixKey = args[0]
            currentGame.totalAmount = parseFloat(args[1])
            currentGame.amountPerPlayer = currentGame.totalAmount / currentGame.players.length
            currentGame.status = 'payment'
            await sendPaymentList(sock, sender, currentGame)
            break

          case 'finalizegame':
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ Apenas administradores podem finalizar jogos!' })
              return
            }
            
            if (!currentGame) {
              await sock.sendMessage(sender, { text: '❌ Nenhum jogo ativo para finalizar' })
              return
            }

            gameHistory.push(currentGame)
            games.delete(sender)
            await sock.sendMessage(sender, { text: '✅ Jogo finalizado! Obrigado a todos!\nUm novo jogo pode ser criado com !createGame' })
            break

          case 'add':
            if (!currentGame || currentGame.status !== 'active') {
              await sock.sendMessage(sender, { text: '❌ Nenhum jogo ativo no momento' })
              return
            }

            if (currentGame.players.length >= currentGame.maxPlayers) {
              await sock.sendMessage(sender, { text: '❌ Jogo já está cheio!' })
              return
            }

            const name = (await sock.onWhatsApp(user))[0].pushname

            if (currentGame.players.some(p => p.phone === user)) {
              await sock.sendMessage(sender, { text: '❌ Você já está na lista!' })
              return
            }

            currentGame.players.push({
              name: name,
              phone: user,
              paid: false
            })
            await sendGameList(sock, sender, currentGame)
            break

          case 'remove':
            if (!currentGame || currentGame.status !== 'active') {
              await sock.sendMessage(sender, { text: '❌ Nenhum jogo ativo no momento' })
              return
            }

            const playerIndex = currentGame.players.findIndex(p => p.phone === user)
            if (playerIndex === -1) {
              await sock.sendMessage(sender, { text: '❌ Você não está na lista!' })
              return
            }

            currentGame.players.splice(playerIndex, 1)
            await sendGameList(sock, sender, currentGame)
            break

          case 'pay':
            if (!currentGame || currentGame.status !== 'payment') {
              await sock.sendMessage(sender, { text: '❌ Pagamentos não estão habilitados para este jogo' })
              return
            }

            const payingPlayer = currentGame.players.find(p => p.phone === user)
            if (!payingPlayer) {
              await sock.sendMessage(sender, { text: '❌ Você não está na lista para pagar!' })
              return
            }

            if (payingPlayer.paid) {
              await sock.sendMessage(sender, { text: '❌ Você já efetuou o pagamento!' })
              return
            }

            payingPlayer.paid = true
            payingPlayer.paymentDate = new Date()
            await sendPaymentList(sock, sender, currentGame)
            break

          case 'cancelpay':
            if (!currentGame || currentGame.status !== 'payment') {
              await sock.sendMessage(sender, { text: '❌ Pagamentos não estão habilitados para este jogo' })
              return
            }

            const cancelingPlayer = currentGame.players.find(p => p.phone === user)
            if (!cancelingPlayer) {
              await sock.sendMessage(sender, { text: '❌ Você não está na lista!' })
              return
            }

            if (!cancelingPlayer.paid) {
              await sock.sendMessage(sender, { text: '❌ Você não efetuou o pagamento ainda!' })
              return
            }

            cancelingPlayer.paid = false
            cancelingPlayer.paymentDate = undefined
            await sendPaymentList(sock, sender, currentGame)
            break

          default:
            await sock.sendMessage(sender, { text: '❌ Comando desconhecido. Comandos disponíveis: !add, !remove, !pay, !cancelPay' })
        }
      }
    } catch (error) {
      console.error('Error processing message:', error)
      await sock.sendMessage(sender, { text: '❌ Ocorreu um erro ao processar seu comando' })
    }
  })
}

// Helper functions
async function sendGameList(sock, groupId, game) {
  let listMessage = `🏐 *Vôlei Larik Club* - ${game.dateTime}\n${game.format} - ${game.courts} quadras\n\n`

  game.players.forEach((player, index) => {
    listMessage += `${index + 1}. ${player.name}\n`
  })

  listMessage += `\nVagas restantes: ${game.maxPlayers - game.players.length}\n`
  listMessage += `Digite !add para entrar ou !remove para sair.`

  await sock.sendMessage(groupId, { text: listMessage })
}

async function sendPaymentList(sock, groupId, game) {
  let paymentMessage = `💰 *Pagamentos Habilitados* 🏐\n`
  paymentMessage += `Chave PIX: ${game.pixKey}\n`
  paymentMessage += `Valor por jogador: R$${game.amountPerPlayer.toFixed(2)}\n\n`
  paymentMessage += `Jogadores:\n`

  game.players.forEach((player, index) => {
    paymentMessage += `${index + 1}. ${player.name} ${player.paid ? '✅' : '❌'}\n`
  })

  paymentMessage += `\nDigite !pay para confirmar pagamento ou !cancelPay para cancelar.`

  await sock.sendMessage(groupId, { text: paymentMessage })
}

// Start the bot
connectToWhatsApp().
  catch(err => console.log('Initial connection error', err))