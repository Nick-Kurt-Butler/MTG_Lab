// Loads the Forge catalog once and exposes a name -> art map for the battle board
// (cards in the snapshot carry only a name; art comes from the catalog).
import { cimg } from './img.js'

let promise = null
export function loadArt() {
  if (!promise) {
    promise = fetch(`${import.meta.env.BASE_URL}data/catalog.json`)
      .then(r => r.json())
      .then(arr => {
        const m = {}
        for (const c of arr) m[c.name] = { image_url: cimg(c.image_url), image_url_back: cimg(c.image_url_back) }
        return m
      })
      .catch(() => ({}))
  }
  return promise
}
