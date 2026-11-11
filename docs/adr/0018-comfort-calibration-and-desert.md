# The Comfort Index is calibrated to afternoons and counts deserts

Builds on ADR 0002 (the Comfort Index) and ADR 0014 (air quality).

The index read Egypt, the Gulf and Spain's interior as pleasant when a visitor would not. Two causes.

**Temperature was judged on the wrong number.** The input is a month's mean daily temperature: the average of day high and night low. The old band counted 18 to 26 °C as perfect and reached zero only at 40 °C. Afternoons run 6 to 8 °C over the mean, more in deserts, so a 26 °C mean is a ~33 °C afternoon and still scored 100. Cairo in April (22 °C mean) scored 100 and in July (31 °C) 66; Manama in April 100; Madrid in July 90. `tempComfort` in `src/lib/comfort.ts` is now a curve (`TEMP_CURVE`): 100 across a 16 to 20 °C mean (afternoons around 21 to 27 °C), falling fast above it (85 at 22, 45 at 26, 15 at 30, 0 at 34) and more gently below (78 at 13, 25 at 4, 0 at -10). A humid-heat term would be better than any mean-based curve, but the stored normals carry no humidity or daily highs, and re-fetching them is a quota question (ADR 0014).

**A month cannot see the year.** Cairo's January is 14 °C with no rain, which on temperature alone is a fine month. What makes Egypt a hard place to spend time in is that it is a desert all year: bare, dusty, glaring, with no shade or green. The index now subtracts a desert penalty from every month of a place that gets little rain in a year: nothing at 400 mm or more, rising linearly to 45 points at 50 mm or less. It needs the whole year's rain, so it applies where a full year is known (stored months, climate cells, on-demand fetches, the When to go and city panel breakdowns) and shows as its own "Desert" row in `ComfortBreakdown` wherever it takes something off. Where only one month is known (a bent Repeat-a-trip template), no desert term applies.

Effect at country level (means over covered cities): Egypt peaks at 46 (December) and is 0 from May to September; the UAE peaks at 54, Bahrain 59, Oman 52, Saudi Arabia 19; coastal Peru at 57. Places with real rain keep their scores: Morocco and Spain still reach 100, Portugal and Greece 99.

Stored scores are not trusted: the seed and the runtime cache are re-scored from temperature, rain and air whenever they load, and climate cells are scored on decode, so a formula change reaches every city without a refetch. Tests pin the curve, the desert scale and real-climate anchors (Cairo, Manama, Madrid, Bangkok).
