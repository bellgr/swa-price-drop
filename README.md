# Southwest Airlines Price Drop

## What/Why?
The prices for Southwest Airlines flights change frequently. If you book a flight and the price drops, you can re-book the same flight and get a refund of the difference in dollars or points. Unfortunately this doesn't happen automatically so you must manually check [southwest.com](https://www.southwest.com) periodically to see if the prices for your booked flights have changed.

`swa-price-drop` will check for price drops on southwest.com for specific flights that you define in a configuration file. If a flight price falls *below* what you paid, you will receive a text message via [Twilio](https://www.twilio.com/) with the news and you can re-book. Once this happens, the flight configuration will be re-written to check against the updated flight price.

For example, you paid $500 for a flight and set `outboundPrice` to `500` accordingly in your configuration file. The price falls to $450 and you receive a notification. The value of `outboundPrice` will now be set to `450` and you will receive a notification if it falls below this new price.

Additionally, flights will be purged from the configuration file automatically once the outbound date is in the past.

## Prerequisites
1. You should set up a free [Twilio](https://www.twilio.com/) account if you don't already have one. You can still run `swa-price-drop` without Twilio and see a "price drop" log message generated but that's not very much fun compared to receiving a text message.

2. At the time of this writing, I'm using version 6.6.0 of [node.js](https://nodejs.org/en/). Anything close to that will probably work.

## Installation
```
$ cd swa-price-drop
$ npm install
```

## Configuration
Hopefully these values are self explanatory. You must enter the correct code values for your origin and destination airport. The `outboundPrice` and `returnPrice` are the price thresholds that will be compared against when fetching price data from Southwest. If a flight falls below these configured prices, you will receive a notification.

```yaml
flights:
  - outboundFlightNumber: 4288
    returnFlightNumber: 233
    originAirport: AUS
    destinationAirport: MSY
    outboundDate: 2/17/2017
    returnDate: 2/20/2017
    adultPassengerCount: 1
    outboundPrice: 255
    returnPrice: 255
  - outboundFlightNumber: 5030
    returnFlightNumber: 6592
    originAirport: AUS
    destinationAirport: MCO
    outboundDate: 3/11/2017
    returnDate: 3/18/2017
    adultPassengerCount: 1
    outboundPrice: 219
    returnPrice: 241
twilio:
  account_sid: [your twilio account_sid]
  auth_token: [your twilio auth_token]
  from: '+15121234567'
  to: '+15121234567'
```
## Usage
```
$ node swa-price-drop.js --config ./swa-price-drop.yml --log ./swa-price-drop.log  --loglevel debug
```

Only `--config` is required. By default, a log file will be placed in `$HOME/swa-price-drop.log` with minimal logging at the `info` level. There is no console output.

## Crontab
I am running this hourly via a cron job. You can adjust this to whatever schedule seems appropriate.
```
5 * * * * /usr/local/bin/node /Users/[username]/swa-price-drop/swa-price-drop.js --config /Users/[username]/swa-price-drop/swa-price-drop.yml
```

## Disclaimer
This will break the moment southwest.com has a site redesign that invalidates the screen scraping logic. No guarantees on how fast I will be able to update if/when that happens. Pull requests are welcome!
