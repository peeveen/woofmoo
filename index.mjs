import { createServer } from "http"
import axios from "axios"
import cheerio from "cheerio"
import async from "async"
import levenshtein from "js-levenshtein"

const wfmu = "WFMU"
const wfmuLivestreamUrl = "http://stream0.wfmu.org/freeform-128k"
const stationLogoGifUrl = "https://www.wfmu.org/images/wfmu_logo_94.gif"
const archivePageUrl = "https://wfmu.org/recentarchives.php"
const archiveFeedUrl = "http://wfmu.org/archivefeed/mp3.xml"
const wfmuBaseUrl = "http://wfmu.org"
// Don't play any archive that's more than 30 days old, as the link has probably expired.
const archiveAgeLimitMilliseconds = 30 * 24 * 60 * 60 * 1000
// Refresh the archive every hour.
const archiveRefreshIntervalMilliseconds = 60 * 60 * 1000
// Port 3000, unless specified by config
const defaultPort = 3000
// Definition of the livestream "show".
const liveStreamShow = {
	titleAnnounce: wfmu,
	description: wfmu,
	mp3Link: wfmuLivestreamUrl,
}
// Default list of shows.
// Livestream is listed as "wfmu" and "play", because weirdly, just saying
// "ask woof moo to play" will return "play" as the archiveName parameter.
const defaultShows = {
	play: liveStreamShow,
	wfmu: liveStreamShow,
}

var archives = defaultShows

async function fetchHtml(url) {
	const { data } = await axios.get(url)
	return cheerio.load(data)
}

function getBestMatchArchive(title) {
	let best = null
	let bestDistance = 10000
	const now = Date.now()
	Object.keys(archives).forEach((key) => {
		const archive = archives[key]
		let distance = levenshtein(title, key)
		if (distance < bestDistance) {
			if (archive.dateFound && now - archive.dateFound > archiveAgeLimitMilliseconds) {
				console.log(`Disregarding match '${archive.titleAnnounce}' as it is past the expiry date.`)
				return
			}
			best = key
			bestDistance = distance
		}
	})
	console.log(`Best match archive title was '${best}' with a Levenshtein distance of ${bestDistance}`)
	return archives[best]
}

function getTitleSynonyms(title) {
	title = title.toLowerCase()
	title = title.replace(/"/g, "")
	title = title.replace(/:/g, "")
	title = title.replace(/!/g, "")
	const synonyms = [title]

	// "[Someone]'s Show" should work if we just ask for [Someone].
	const sShowRegExp = /(.+)'s show/
	const sShowMatches = title.match(sShowRegExp)
	if (sShowMatches && sShowMatches.length > 1) synonyms.push(sShowMatches[1])
	// "The Glen Jones Radio Programme" should work if we just ask for "Glen Jones"
	const theRadioProgrammeRegExp = /the (.+) radio programme/
	const theRadioProgrammeMatches = title.match(theRadioProgrammeRegExp)
	if (theRadioProgrammeMatches && theRadioProgrammeMatches.length > 1) synonyms.push(theRadioProgrammeMatches[1])
	return synonyms
}

async function applyShow(title, date, m3uLink, shows) {
	const now = Date.now()
	if (m3uLink && title && date) {
		const { data } = await axios.get(m3uLink)
		const titleSynonyms = getTitleSynonyms(title)
		const archive = {
			titleAnnounce: title,
			description: "WFMU archive",
			date: date,
			mp3Link: data.trim(),
			dateFound: now,
		}
		titleSynonyms.forEach((title) => (shows[title] = archive))
	}
}

async function refreshArchiveListFromHtml(archivePageUrl) {
	console.log("Refreshing archive list from HTML ...")
	const $ = await fetchHtml(archivePageUrl)
	const items = $(".program")
	const shows = { ...defaultShows }
	await async.each(items, async function (item) {
		const links = $("a.archive-link", item)
		const dates = $("span.archive-link", item)
		let m3uLink = null,
			showTitle = null,
			showDate = null
		if (dates && dates.length > 0) {
			const dateText = $(dates[0]).text().trim()
			const dateMatches = dateText.match(/(.+):[.|\s]*/)
			if (dateMatches && dateMatches.length > 0) showDate = dateMatches[1].trim().toLowerCase()
		}
		if (links && links.length > 0) {
			const hrefLink = $(links[0]).attr("href")
			m3uLink = `${wfmuBaseUrl}${hrefLink}`
		}
		const titles = $("a.show-title-link", item)
		if (titles && titles.length > 0) showTitle = $(titles[0]).text()
		await applyShow(showTitle, showDate, m3uLink, shows)
	})
	return shows
}

async function refreshArchiveListFromXml(archiveFeedUrl) {
	console.log("Refreshing archive list from XML ...")
	const $ = await fetchHtml(archiveFeedUrl)
	const items = $("item")
	const shows = { ...defaultShows }
	await async.each(items, async function (item) {
		const links = $(item).children("guid")
		let m3uLink = null,
			showTitle = null,
			showDate = null
		if (links && links.length > 0) m3uLink = $(links[0]).text()
		const titles = $(item).children("title")
		if (titles && titles.length > 0) {
			showTitle = $(titles[0]).text()
			const regExp1 = /WFMU MP3 Archive: (.+) from (.+)/
			const matchParts1 = showTitle.match(regExp1)
			if (matchParts1 && matchParts1.length > 2) {
				showTitle = matchParts1[1]
				showDate = matchParts1[2]
				const regExp2 = /(.+) with (.+)/
				for (;;) {
					const matchParts2 = showTitle.match(regExp2)
					if (matchParts2 && matchParts2.length > 2) showTitle = matchParts2[1]
					else break
				}
			}
		}
		await applyShow(showTitle, showDate, m3uLink, shows)
	})
	return shows
}

const server = createServer(async (request, response) => {
	if (request.method == "GET") {
		response.writeHead(200, { "Content-Type": "text/html" })
		Object.keys(archives).forEach((key) => {
			const archive = archives[key]
			response.write(
				`Name: ${key}, Title: ${archive.titleAnnounce}, Date: ${archive.date}, MP3 Link: ${archive.mp3Link}<br/>`
			)
		})
		response.end()
	} else if (request.method == "POST") {
		let body = ""
		request.on("data", (chunk) => (body += chunk))
		request.on("end", () => {
			console.log(body)
			const params = JSON.parse(body)
			let conv = {
				session: {
					id: params.session.id,
					params: {},
				},
			}
			if (params.handler.name == "getArchiveTitles") {
				conv.expected = {
					speech: Object.keys(archives),
				}
			} else if (params.handler.name == "validateSlots") {
				conv.scene = params.scene
				conv.scene.slotFillingStatus = "FINAL"
				conv.scene.slots.ArchiveName.status = "FILLED"
			} else if (params.handler.name == "playArchive") {
				const requestedArchiveName = params.session.params.archiveName.toLowerCase()
				console.log(`Looking for archive with title ${requestedArchiveName}`)
				let matchedArchive = archives[requestedArchiveName]
				if (matchedArchive == null) matchedArchive = getBestMatchArchive(requestedArchiveName)
				if (matchedArchive) {
					let dateAnnounce = ""
					if (matchedArchive.date) dateAnnounce = ` from ${matchedArchive.date}`
					conv.prompt = {
						override: false,
						content: {
							media: {
								media_type: "AUDIO",
								optional_media_controls: ["PAUSED", "STOPPED"],
								media_objects: [
									{
										name: matchedArchive.titleAnnounce,
										description: matchedArchive.description,
										url: matchedArchive.mp3Link,
										image: {
											large: {
												url: stationLogoGifUrl,
												alt: "WFMU station logo",
											},
										},
									},
								],
							},
						},
						firstSimple: {
							speech: `OK, playing ${matchedArchive.titleAnnounce}${dateAnnounce}`,
						},
					}
				}
			}
			const jsonResponse = JSON.stringify(conv)
			console.log(jsonResponse)
			response.writeHead(200, { "Content-Type": "application/json" })
			response.write(jsonResponse)
			response.end()
		})
	}
})

const refreshFunction = async () => {
	const latestArchives = await refreshArchiveListFromXml(archiveFeedUrl)
	archives = Object.assign({}, archives, latestArchives)
}
// The archives page lists all shows, but there may be multiples of the same
// show (e.g. Wake), so it's anyone's guess which one will be in the collection
// when this function is done.
archives = await refreshArchiveListFromHtml(archivePageUrl)
// However, the XML feed only lists the LATEST shows, but it only lists about
// two-thirds of the shows for the whole week, annoyingly. But by running this
// once, we will be sure to have the latest of the daily shows.
await refreshFunction()
// Now update list from XML feed every 15 mins to keep it fresh.
const interval = setInterval(refreshFunction, archiveRefreshIntervalMilliseconds)

const port = process.env.PORT || defaultPort
console.log(`Woof Moo initializing on port ${port} ...`)
server.listen(port)
