import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const port = Number(process.env.PORT) || 5173
const host = '0.0.0.0'
const distDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

app.use(express.static(distDirectory))

app.get('*', (_request, response) => {
  response.sendFile(path.join(distDirectory, 'index.html'))
})

app.listen(port, host, () => {
  console.log(`Web server listening on http://${host}:${port}`)
})
