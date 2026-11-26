# The desert term spares mild ocean climates

Amends ADR 0018 (the desert term). Leaves the temperature curve (ADR 0018, 0023) as it is.

ADR 0018 took up to 45 points off every month of a place with little rain in a year. Rain alone cannot tell an ocean-cooled dry island from Cairo. Lanzarote (about 80 mm a year), Fuerteventura (about 60 mm) and La Gomera's dry east coast are dry, but surrounded by the Atlantic, with steady trade winds (*alisios*), mean temperatures between 17 and 25 °C all year and little gap between seasons. The term scored Arrecife's January (17 °C, 6 mm) at 58 and its August at 37, as if it were an Egyptian spring. The owner lives in the Canaries, and these are the places their rotation is looking for: sunny but not hot.

**The share.** The desert penalty is now multiplied by a share read from the same monthly means the index already has:

- **Heat:** the warmest month's mean. None at 24 °C or below, all at 28 °C or above.
- **Swing:** the warmest month's mean minus the coldest month's. None at 9 °C or below, all at 15 °C or above. This keeps continental deserts with mild summers, such as the Gobi, fully penalised.

The share is the larger of the two. Without the year's temperatures (a bare rain total from an older caller) the penalty applies in full, as before. The breakdown row says so when the share is below 100%, e.g. "62 mm of rain a year; a mild ocean climate (warmest month 25 °C) keeps 25% of the penalty".

**Effect.**

| Place | Warmest / coldest month mean | Share | Best month | Hottest month |
|---|---|---|---|---|
| Arrecife (Lanzarote) | 23.6 / 17.1 °C | 0% | 58 → 100 | 37 → 78 |
| Fuerteventura (airport) | 25.0 / 17.6 °C | 25% | 57 → 89 | 27 → 59 |
| El Hierro (airport) | 23.7 / 18.1 °C | 0% | 78 → 100 | 55 → 78 |
| Tenerife south (TFS) | 26.2 / 17.7 °C | 55% | 86 → 92 | 49 → 55 |
| Cairo | 28.5 / 14 °C | 100% | 55 → 55 | 0 → 0 |
| Lima | 23 / 17 °C | 0% | 58 → 100 | — |

Summer heat still counts, through the temperature curve: Fuerteventura's August stays well below its spring. Cairo, the Gulf, Phoenix and the Gobi keep the full penalty.

**Known side effect.** Lima's coast and other cool coastal deserts (Arica, Swakopmund) lose the penalty too. They are mild by temperature, but sit under a grey sea fog (*garúa*) for months, which the stored normals cannot see: they carry no cloud or sunshine. A sunshine term would separate them from the Canaries; it needs new normals from the provider (ADR 0014).

Rejected:

- **A list of exempt places.** That would be a judgement in the data, not a measurement, and would miss the next Atlantic island.
- **Dropping the desert term.** Hot deserts would read as pleasant in their mild months again, the problem ADR 0018 fixed.
