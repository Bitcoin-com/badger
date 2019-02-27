const SLPSDK = require('slp-sdk/lib/SLP').default
const SLP = new SLPSDK()
const BigNumber = require('slpjs/node_modules/bignumber.js')
const slpjs = require('slpjs')
const WH = require('wormhole-sdk/lib/Wormhole').default
const Wormhole = new WH({
  restURL: `https://rest.bitcoin.com/v1/`,
})

class BitboxUtils {
  static async getLargestUtxo (address) {
    return new Promise((resolve, reject) => {
      SLP.Address.utxo(address).then(
        result => {
          try {
            const utxo = result.utxos.sort((a, b) => {
              return a.satoshis - b.satoshis
            })[result.utxos.length - 1]
            resolve(utxo)
          } catch (ex) {
            reject(ex)
          }
        },
        err => {
          reject(err)
        }
      )
    })
  }

  static async getAllUtxo (address) {
    return new Promise((resolve, reject) => {
      SLP.Address.utxo(address).then(
        result => {
          resolve(result.utxos)
        },
        err => {
          reject(err)
        }
      )
    })
  }

  static async getTransactionDetails (txid) {
    return new Promise((resolve, reject) => {
      SLP.Transaction.details(txid).then(
        result => {
          if (result) {
            resolve(result)
          } else {
            reject('Undefined transaction details for', txid)
          }
        },
        err => {
          reject(err)
        }
      )
    })
  }

  static encodeOpReturn (dataArray) {
    const script = [SLP.Script.opcodes.OP_RETURN]
    dataArray.forEach(data => {
      if (typeof data === 'string' && data.substring(0, 2) === '0x') {
        script.push(Buffer.from(data.substring(2), 'hex'))
      } else {
        script.push(Buffer.from(data))
      }
    })
    return SLP.Script.encode(script)
  }

  static async publishTx (hex) {
    return new Promise((resolve, reject) => {
      SLP.RawTransactions.sendRawTransaction(hex).then(
        // TODO: pass back result instead of result[0] after we update REST to return string instead of array
        result => {
          try {
            if (result[0].length !== 64) {
              // TODO: Validate result is a txid
              reject('Transaction failed: ' + result)
            } else {
              resolve(result[0])
            }
          } catch (ex) {
            reject(ex)
          }
        },
        err => {
          reject(err)
        }
      )
    })
  }

  static signAndPublishBchTransaction (txParams, keyPair, spendableUtxos) {
    return new Promise(async (resolve, reject) => {
      try {
        const from = txParams.from
        const to = txParams.to
        const satoshisToSend = parseInt(txParams.value)

        // Calculate fee
        let byteCount = SLP.BitcoinCash.getByteCount(
          { P2PKH: spendableUtxos.length },
          { P2PKH: 2 }
        )
        if (txParams.opReturn) {
          byteCount +=
            this.encodeOpReturn(txParams.opReturn.data).byteLength + 10
        }

        if (!spendableUtxos || spendableUtxos.length === 0) {
          throw new Error('Insufficient funds')
        }

        // TODO: support testnet
        const transactionBuilder = new SLP.TransactionBuilder('mainnet')

        let totalUtxoAmount = 0
        spendableUtxos.forEach(utxo => {
          if (utxo.spendable !== true) {
            throw new Error('Cannot spend unspendable utxo')
          }
          transactionBuilder.addInput(utxo.txid, utxo.vout)
          totalUtxoAmount += utxo.satoshis
        })

        const satoshisRemaining = totalUtxoAmount - byteCount - satoshisToSend

        // Destination output
        transactionBuilder.addOutput(to, satoshisToSend)

        // Op Return
        // TODO: Allow dev to pass in "position" property for vout of opReturn
        if (txParams.opReturn) {
          const encodedOpReturn = this.encodeOpReturn(txParams.opReturn.data)
          transactionBuilder.addOutput(encodedOpReturn, 0)
        }

        // Return remaining balance output
        if (satoshisRemaining >= 546) {
          transactionBuilder.addOutput(from, satoshisRemaining)
        }

        let redeemScript
        spendableUtxos.forEach((utxo, index) => {
          transactionBuilder.sign(
            index,
            keyPair,
            redeemScript,
            transactionBuilder.hashTypes.SIGHASH_ALL,
            utxo.satoshis
          )
        })

        const hex = transactionBuilder.build().toHex()

        // TODO: Handle failures: transaction already in blockchain, mempool length, networking
        const txid = await this.publishTx(hex)
        resolve(txid)
      } catch (err) {
        reject(err)
      }
    })
  }

  static signAndPublishSlpTransaction (
    txParams,
    keyPair,
    spendableUtxos,
    tokenMetadata,
    spendableTokenUtxos
  ) {
    return new Promise(async (resolve, reject) => {
      try {
        const from = txParams.from
        const to = txParams.to
        const tokenDecimals = tokenMetadata.decimals
        const scaledTokenSendAmount = new BigNumber(
          txParams.value
        ).decimalPlaces(tokenDecimals)
        const tokenSendAmount = scaledTokenSendAmount.times(10 ** tokenDecimals)

        let tokenBalance = new BigNumber(0)
        for (const tokenUtxo of spendableTokenUtxos) {
          const utxoBalance = tokenUtxo.slp.quantity
          tokenBalance = tokenBalance.plus(utxoBalance)
        }

        if (!tokenBalance.gte(tokenSendAmount)) {
          throw new Error('Insufficient tokens')
        }

        const tokenChangeAmount = tokenBalance.minus(tokenSendAmount)

        let sendOpReturn

        if (tokenChangeAmount.isGreaterThan(0)) {
          sendOpReturn = slpjs.slp.buildSendOpReturn({
            tokenIdHex: txParams.sendTokenData.tokenId,
            outputQtyArray: [ tokenSendAmount, tokenChangeAmount ],
          })
        } else {
          sendOpReturn = slpjs.slp.buildSendOpReturn({
            tokenIdHex: txParams.sendTokenData.tokenId,
            outputQtyArray: [ tokenSendAmount ],
          })
        }

        const inputUtxos = spendableUtxos.concat(spendableTokenUtxos)

        const tokenReceiverAddressArray = [to, from]

        const transactionBuilder = new SLP.TransactionBuilder('mainnet')

        let totalUtxoAmount = 0
        inputUtxos.forEach(utxo => {
          transactionBuilder.addInput(utxo.txid, utxo.vout)
          totalUtxoAmount += utxo.satoshis
        })

        const byteCount = slpjs.slp.calculateSendCost(
          sendOpReturn.length,
          inputUtxos.length,
          tokenReceiverAddressArray.length + 1, // +1 to receive remaining BCH
          from
        )

        const satoshisRemaining = totalUtxoAmount - byteCount

        // SLP data output
        transactionBuilder.addOutput(sendOpReturn, 0)

        // Token destination output
        transactionBuilder.addOutput(to, 546)

        // Return remaining token balance output
        if (tokenChangeAmount.isGreaterThan(0)) {
          transactionBuilder.addOutput(from, 546)
        }

        // Return remaining bch balance output
        transactionBuilder.addOutput(from, satoshisRemaining + 546)

        let redeemScript
        inputUtxos.forEach((utxo, index) => {
          transactionBuilder.sign(
            index,
            keyPair,
            redeemScript,
            transactionBuilder.hashTypes.SIGHASH_ALL,
            utxo.satoshis
          )
        })

        const hex = transactionBuilder.build().toHex()

        const txid = await this.publishTx(hex)
        resolve(txid)
      } catch (err) {
        reject(err)
      }
    })
  }

  static signAndPublishWormholeTransaction (
    txParams,
    keyPair,
    spendableUtxos,
    propertyId
  ) {
    return new Promise(async (resolve, reject) => {
      try {
        const from = txParams.from
        const to = txParams.to
        const sendTokenAmount = txParams.value

        if (!spendableUtxos || spendableUtxos.length === 0) {
          throw new Error('Insufficient funds')
        }

        // const propertyId = tokenMetadata.protocolData.propertyId
        const payload = await Wormhole.PayloadCreation.simpleSend(
          propertyId,
          sendTokenAmount.toString()
        )

        let inputUtxos = spendableUtxos.map(utxo => {
          utxo.value = utxo.amount
          return utxo
        })
        if (inputUtxos.length >= 2) {
          inputUtxos = inputUtxos.sort((a, b) => a.satoshis - b.satoshis)
        }
        let inputUtxo
        for (const utxo of inputUtxos) {
          if (utxo.satoshis > 1000) {
            inputUtxo = utxo
            break
          }
        }

        if (!inputUtxo) {
          throw new Error('Insufficient funds to send tokens')
        }

        const rawTx = await Wormhole.RawTransactions.create([inputUtxo], {})
        const opReturn = await Wormhole.RawTransactions.opReturn(rawTx, payload)
        const ref = await Wormhole.RawTransactions.reference(opReturn, to)
        const changeHex = await Wormhole.RawTransactions.change(
          ref,
          [inputUtxo],
          from,
          0.00001
        )
        const tx = Wormhole.Transaction.fromHex(changeHex)
        const tb = Wormhole.Transaction.fromTransaction(tx)

        let totalUtxoAmount = 0
        inputUtxos.forEach(utxo => {
          if (utxo.spendable !== true) {
            throw new Error('Cannot spend unspendable utxo')
          }
          // transactionBuilder.addInput(utxo.txid, utxo.vout)
          totalUtxoAmount += utxo.satoshis
        })

        let redeemScript
        tb.sign(0, keyPair, redeemScript, 0x01, inputUtxo.satoshis)
        const builtTx = tb.build()
        const hex = builtTx.toHex()

        // TODO: Handle failures: transaction already in blockchain, mempool length, networking
        const txid = await this.publishTx(hex)
        resolve(txid)
      } catch (err) {
        reject(err)
      }
    })
  }
}

module.exports = BitboxUtils
