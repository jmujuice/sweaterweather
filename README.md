# Sweater Weather

A one-page weather app using National Weather Service data, with a "What should I wear?" card.
Hosted on GitHub Pages at https://sweaterweather.justinsethi.com. No build step and no dependencies.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout and styles |
| `js/app.js` | Location, NWS data fetching, the data model, and all rendering |
| `js/interpret.js` | Weather interpretation: clothing temperature, wind, rain intensity and timing, time windows |
| `js/recommend.js` | Outfit recommendation: temperature bands, rules, and wording. Returns plain data, not HTML |
| `js/solar.js` | Sun position and UV index estimate |
| `tests/` | Unit tests for the three engine files |

## Tuning the outfit logic

All thresholds are at the top of the engine files:

- `INTERPRET` in `js/interpret.js`: wind adjustments, comfort and activity offsets, rain thresholds, intensity rates
- `RECOMMEND` in `js/recommend.js`: temperature bands, clothing per band, wording, alert thresholds

## Running the tests

Requires Node 18 or newer:

```
npm test
```

Run the tests after any change to the engine files, before pushing.
