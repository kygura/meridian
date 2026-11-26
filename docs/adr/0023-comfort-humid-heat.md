# The Comfort Index eases humid heat, and Beauty can justify a base

Amends ADR 0018 (the afternoon-calibrated curve) and ADR 0022 (Locales). Leaves ADR 0002 and 0014 as they are.

ADR 0018 made the hot side of the temperature curve steep so that deserts and dry continental summers stopped reading as pleasant. It worked, but it overshot for the humid tropics, which carry the steep curve and a full rain penalty at once. A 27 °C month with ordinary rain, the best month of Penang, Bangkok, Galle or Goa, scored 18 to 30, the same "poor" as a monsoon month or a desert spring. The owner's rotation runs through those places on purpose: they are among the most beautiful in the dataset, and their good months are good enough to live in.

**The curve.** Unchanged up to 20 °C. Above it: 88 at 22, 76 at 24, 64 at 26, 50 at 28, 36 at 30, 22 at 32, 9 at 34, 0 at 36 (was 85, 65, 45, 28, 15, 6, 0 at 34). Deserts stay low through the desert term, which is what really separates them (ADR 0018): Cairo's best month is still 55, its May 16, the Gulf from April under 25.

**Rain in heat.** Heat and monsoon rain both stand for the same muggy afternoon, so in a month hotter than the 16–20 °C band the rain penalty is scaled by `0.6 + 0.4 × heat score / 100`: all of it at a heat score of 100, 60 % as the score falls to 0. A cool monsoon (Bhutan, 17 °C and 400 mm) keeps the full 35 points; a capped rain scale was tried first and made that look fine, so it was dropped.

**Effect.** A humid tropical best month (27 °C, 70 mm) is now about 52, "fair"; Bangkok is 60 in December and 25 in July, still clearly apart. A dry 26–27 °C summer moves up too: Madrid's July is 54 (was below 40), Valencia's August fair. That is the cost of one curve for both; the stored normals still have no humidity or daily highs to tell them apart (ADR 0018). Every screen that shows the index moves with it, and nothing needs migrating: scores are recomputed from temperature, rain and air whenever data loads.

**Beauty can justify a base (Locales).** A place in Meridian's top 15 % for Beauty (the `beauty` metric surface, ADR 0008) whose months never get better than fair gets a "worth it" window: its most tolerable months, within 10 Comfort points of its own peak, when that stretch is longer than its fair run. It is drawn dashed and labelled. In rankings a month inside such a window counts as fair, and Beauty breaks ties, so a beautiful humid base shows up in its season next to the comfortable ones. A place without the Beauty gets no such window: comfort alone decides.

Rejected: rescaling the index per place (colours would stop comparing places); a Locales-only "tolerance" setting (the owner asked for the index itself to stop overshooting); a dry-heat shift that judged dry months a few degrees hotter (it pushed tropical dry seasons back down, which is the opposite of the point).
