import { describe, expect, it } from "vitest";
import { flightLinks, groundLinks, legLinks, stayLinks } from "./bookLinks";

const LPA = { name: "Las Palmas", iata: "LPA", country: "Spain" };
const LIS = { name: "Lisbon", iata: "LIS", country: "Portugal" };
const bySite = (links: { site: string; url: string }[]) => Object.fromEntries(links.map((l) => [l.site, l.url]));

describe("flightLinks", () => {
  it("prefills route, date and travellers on each site", () => {
    const links = flightLinks({ from: LPA, to: LIS, date: "2027-03-01", travellers: 2 });
    const u = bySite(links);
    expect(decodeURIComponent(u["google-flights"])).toBe("https://www.google.com/travel/flights?q=Flights from LPA to LIS on 2027-03-01 one way for 2 adults");
    expect(u.skyscanner).toBe("https://www.skyscanner.net/transport/flights/lpa/lis/270301/?adultsv2=2&cabinclass=economy&rtn=0");
    expect(u.kayak).toBe("https://www.kayak.com/flights/LPA-LIS/2027-03-01/2adults");
    expect(links.every((l) => l.prefills === "route, date and travellers")).toBe(true);
  });

  it("offers only the site that can search without a date, and says what it fills in", () => {
    const links = flightLinks({ from: LPA, to: LIS });
    expect(links.map((l) => l.site)).toEqual(["google-flights"]);
    expect(links[0].prefills).toBe("route and travellers");
    expect(decodeURIComponent(links[0].url)).toMatch(/Flights from LPA to LIS one way$/);
  });

  it("gives nothing without an airport at both ends", () => {
    expect(flightLinks({ from: { name: "Sintra" }, to: LIS, date: "2027-03-01" })).toEqual([]);
  });

  it("keeps the head count sane", () => {
    expect(bySite(flightLinks({ from: LPA, to: LIS, date: "2027-03-01", travellers: 40 })).kayak).toMatch(/\/9adults$/);
    expect(bySite(flightLinks({ from: LPA, to: LIS, date: "2027-03-01", travellers: 0 })).kayak).toMatch(/2027-03-01$/);
  });
});

describe("groundLinks", () => {
  it("opens the route on Rome2Rio and Google Maps, and admits the date isn't carried", () => {
    const links = groundLinks({ from: LIS, to: { name: "Porto", country: "Portugal" }, date: "2027-03-05" }, "train");
    const u = bySite(links);
    expect(u.rome2rio).toBe("https://www.rome2rio.com/map/Lisbon-Portugal/Porto-Portugal");
    expect(u["google-maps"]).toBe("https://www.google.com/maps/dir/?api=1&origin=Lisbon%2C%20Portugal&destination=Porto%2C%20Portugal&travelmode=transit");
    expect(links[0].prefills).toMatch(/pick the date there/);
    expect(bySite(groundLinks({ from: LIS, to: LPA }, "drive"))["google-maps"]).toMatch(/travelmode=driving$/);
  });

  it("routes by mode", () => {
    expect(legLinks({ from: LPA, to: LIS, date: "2027-03-01" }, "flight").map((l) => l.site)).toContain("kayak");
    expect(legLinks({ from: LPA, to: LIS, date: "2027-03-01" }, "ferry").map((l) => l.site)).toEqual(["rome2rio", "google-maps"]);
  });
});

describe("stayLinks", () => {
  it("prefills city, dates and guests", () => {
    const u = bySite(stayLinks({ place: LIS, checkIn: "2027-03-01", checkOut: "2027-03-08", travellers: 2 }));
    const booking = new URL(u.booking);
    expect(booking.origin + booking.pathname).toBe("https://www.booking.com/searchresults.html");
    expect(Object.fromEntries(booking.searchParams)).toEqual({ ss: "Lisbon, Portugal", group_adults: "2", no_rooms: "1", checkin: "2027-03-01", checkout: "2027-03-08" });
    expect(u.airbnb).toBe("https://www.airbnb.com/s/Lisbon--Portugal/homes?adults=2&checkin=2027-03-01&checkout=2027-03-08");
    expect(u.flatio).toBeUndefined();
  });

  it("adds monthly rentals from 28 nights", () => {
    const short = stayLinks({ place: LIS, checkIn: "2027-03-01", checkOut: "2027-03-28" });
    expect(short.map((l) => l.site)).toEqual(["booking", "airbnb"]);
    const long = stayLinks({ place: LIS, checkIn: "2027-03-01", checkOut: "2027-03-29" });
    expect(long.map((l) => l.label)).toEqual(["Booking.com", "Airbnb (monthly rates)", "Flatio"]);
    expect(bySite(long).flatio).toBe("https://www.flatio.com/s/Lisbon");
    expect(long[2].prefills).toBe("city only; set the dates there");
  });

  it("searches the city alone when there are no dates", () => {
    const links = stayLinks({ place: { name: "Da Nang", country: "Vietnam" } });
    expect(links[0].prefills).toBe("city and guests");
    expect(links[0].url).not.toContain("checkin");
    expect(links[1].url).toBe("https://www.airbnb.com/s/Da-Nang--Vietnam/homes?adults=1");
  });
});
