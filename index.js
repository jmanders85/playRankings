const { series, whilst } = require('async')
const https = require('https')
const { parseString } = require('xml2js')
const cheerio = require('cheerio')
const moment = require('moment')
const fs = require('fs')
const readline = require('readline')

const COLLECTION_URL = username => `https://www.boardgamegeek.com/xmlapi2/collection?username=${username}&own=1`
const ALL_TIME_PLAYS_URL = (id, page) => `https://boardgamegeek.com/playstats/thing/${id}/page/${page}`
const GAMES_PLAYED_URL = (username, page) => `https://boardgamegeek.com/plays/bygame/user/${username}/subtype/boardgame/page/${page}`
const FILE_HEADERS = ['Game', 'Rank', 'Plays', 'Rank 1 Plays', 'Rank 5 Plays', 'Rank 10 Plays', 'Rank 20 Plays', 'Rank 100 Plays', 'GHI', 'Owned?'].join('|') + '\n'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

(function () {
  rl.question('Username: ', username => {
    getPlayRankings(username)
  })
})()

async function getPlayRankings(username) {
  const collection = await getCollection(username)

  if (collection) {
    const { userGames, updatedUserName } = await getGamesPlayed(username)
    const gameRankings = await getGameRankings(updatedUserName, userGames, collection)
    buildFile(username, gameRankings)
  }
}

function getCollection(username) {
  return new Promise(async resolve => {
    console.log('collection hunting for', username)

    let collectionJSON = { message: true }

    whilst(
      cb => {
        cb(null, collectionJSON.message)
      },
      function (cb) {
        https.get(COLLECTION_URL(username), res => {
          let b = ''
          res.on('data', d => b += d)
          res.on('end', () => {
            parseString(b, async (err, xml2jsres) => {
              if (err) throw err

              collectionJSON = xml2jsres

              if (collectionJSON.message) {
                console.log('gotta wait for collection')
                setTimeout(() => {
                  cb(null, collectionJSON)
                }, 5000)
              } else if (collectionJSON.items) {
                cb(null, collectionJSON.items.item.map(i => i.$.objectid))
              } else {
                cb('No user')
              }
            })
          })
        })
      },
      (err, collection) => {
        if (err) {
          console.log('no user by that name')
          resolve(false)
        } else {
          console.log('collection received')
          resolve(collection)
        }
      }
    )
  })
}

function getGameRankings(username, gamesPlayed, collection) {
  return new Promise(resolve => {
    series(gamesPlayed.map(gp => {
      return seriesCallback => {
        const { id, game } = gp
        console.log(game)

        let page = 0
        let pageUserIsOn = 0
        let userIndexOnPage = -1
        let plays, rank1plays, rank5plays, rank10plays, rank20plays, rank100plays, ghi

        whilst(
          cb => cb(null, userIndexOnPage === -1 || !ghi),
          cb => {
            https.get(ALL_TIME_PLAYS_URL(id, ++page), res => {
              let b = ''

              res.on('data', d => b += d)
              res.on('end', () => {
                const $ = cheerio.load(b)
                const $trs = $('.forum_table').children().children()
                const rows = $trs.length - 1
                if (rows === 0) {
                  userIndexOnPage = 0
                  plays = 'NR'
                  pageUserIsOn = page
                }

                if (page === 1 || !ghi) {
                  if (page === 1) {
                    const getRankPlays = getRankPlaysFromTrs($trs)
                    rank1plays = getRankPlays(1)
                    rank5plays = getRankPlays(5)
                    rank10plays = getRankPlays(10)
                    rank20plays = getRankPlays(20)
                    rank100plays = getRankPlays(100)
                  }

                  if (!ghi) {
                    $trs.each((i, e) => {
                      if (!ghi && i > 0) {
                        const rank = 100 * (page - 1) + i
                        const plays = $(e).children().eq(1).find('a').text().trim()
                        if (rank > +plays) {
                          ghi = rank - 1
                        } else if (i === rows && rows < 100) {
                          ghi = rank
                        }
                      }
                    })
                  }
                }

                const userRow = $(`a[href="/user/${username}"]`).closest('tr')
                if (userRow.length) {
                  userIndexOnPage = userRow.index()
                  plays = userRow.children('.lf').text().trim()
                  pageUserIsOn = page
                }

                cb()
              })
            })
          },
          () => {
            const rank = 100 * (pageUserIsOn - 1) + userIndexOnPage
            seriesCallback(null, { game, rank, plays, rank1plays, rank5plays, rank10plays, rank20plays, rank100plays, ghi, owned: collection.includes(id) })
          }
        )
      }
    }),
      (err, results) => {
        resolve(results)
      })
  })
}

function getGamesPlayed(username) {
  const userGames = []
  let updatedUserName = ''

  return new Promise(async resolve => {
    let page = 1
    let areThereStillMoreGames = true
    whilst(
      cb => cb(null, areThereStillMoreGames),
      cb => {
        https.get(GAMES_PLAYED_URL(username, page++), res => {
          let b = ''
          res.on('data', d => b += d)
          res.on('end', () => {
            let $ = cheerio.load(b)
            if (page == 2) {
              updatedUserName = $('h2').find('a').text().trim()
            }
            if ($('.messagebox').length) {
              areThereStillMoreGames = false
            } else {
              const $trs = $('.forum_table').eq(1).children().children()
              $trs.each((i, e) => {
                if (i > 0) {
                  const $a = $(e).children('td').eq(0).children('a')
                  const id = $a.attr('href').split('/')[2]
                  const game = $a.text().trim()
                  userGames.push({ id, game })
                }
              })
            }

            cb()
          })
        })
      },
      () => {
        console.log('got games played for', updatedUserName)
        resolve({ userGames, updatedUserName })
      }
    )
  })
}

function getRankPlaysFromTrs($trs) {
  return rank => {
    return $trs.eq(rank).children().eq(1).find('a').text().trim() || 'N/A'
  }
}

function buildFile(username, gameRankings) {
  const DATE = moment().format('YYYYMMDD')
  const FILE_NAME = `${username}_${DATE}.csv`

  fs.appendFileSync(FILE_NAME, FILE_HEADERS)
  gameRankings.forEach(({ game, rank, plays, rank1plays, rank5plays, rank10plays, rank20plays, rank100plays, ghi, owned }) => {
    fs.appendFileSync(FILE_NAME, [game, rank, plays, rank1plays, rank5plays, rank10plays, rank20plays, rank100plays, ghi, owned].join('|') + '\n')
  })
}
