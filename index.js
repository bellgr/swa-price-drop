"use strict"

const async = require('async');
const yaml = require('js-yaml');
const fs = require('fs');
const osmosis = require('osmosis');
const twilio = require('twilio');
const winston = require('winston');

if (process.argv.length <= 2) {
  console.log("Usage: node " + __filename + " --config [/path/to/swa-price-drop.yml]");
  process.exit(-1);
}

var configFile;
var config;
var updatedFlights = [];

process.argv.forEach((arg, i, argv) => {
  switch (arg) {
    case "--config":
      configFile = argv[i + 1];
      try {
        config = yaml.safeLoad(fs.readFileSync(configFile, 'utf8'));
      } catch (e) {
        console.log(e);
        process.exit(-1);
      }
      break;
  }
});

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({
      timestamp: true,
      level: 'info'
    }),
    new (winston.transports.File)({
      timestamp: true,
      json: false,
      level: 'debug',
      filename: 'swa-price-drop.log'
    })
  ]
});

const notify = (message) => {
  // send a text message
  if (config.twilio) {
    try {
      const twilioClient = twilio(config.twilio.account_sid, config.twilio.auth_token);

      twilioClient.sendMessage({
        from: config.twilio.from,
        to: config.twilio.to,
        body: message
      }, function(err, data) {
        if (err) {
          logger.error(err);
        }
      })
    } catch(e) {}
  }

  // log the price drop
  logger.info(message);
}

const checkSouthwest = (flightConfig, cb) => {
  const outboundFares = [];
  const returnFares = [];

  logger.debug("Checking southwest.com for prices with parameters:\n" +
    "originAirport: " + flightConfig.originAirport + "\n" +
    "destinationAirport: " + flightConfig.destinationAirport + "\n" +
    "outboundDateString: " + flightConfig.outboundDate + "\n" +
    "returnDateString: " + flightConfig.returnDate + "\n" +
    "adultPassengerCount: " + flightConfig.adultPassengerCount);

  osmosis
    .get("https://www.southwest.com")
    .submit(".booking-form--form", {
      twoWayTrip: true,
      airTranRedirect: "",
      returnAirport: "RoundTrip",
      outboundTimeOfDay: "ANYTIME",
      returnTimeOfDay: "ANYTIME",
      seniorPassengerCount: 0,
      fareType: "DOLLARS",
      originAirport: flightConfig.originAirport,
      destinationAirport: flightConfig.destinationAirport,
      outboundDateString: flightConfig.outboundDate,
      returnDateString: flightConfig.returnDate,
      adultPassengerCount: flightConfig.adultPassengerCount
    })
    .set({
      out: [
        osmosis
        .find("table[@id='faresOutbound']/tbody/tr")
        .then((outboundData) => {
          const flights = outboundData.find(".js-flight-performance");

          // Loop through all the outbound flights and find the flight number
          // we are interested in
          for (let flight of flights) {
            const matches = flight.text().match(/\d+/);
            const flightNumber = matches[0];

            // we found the right flight number row - parse the prices for this row
            if (flightNumber == flightConfig.outboundFlightNumber) {
              const prices = outboundData.find(".product_price");
              for (let rawPrice of prices) {
                const priceMatch = rawPrice.toString().match(/\$.*?(\d+)/);
                const price = parseInt(priceMatch[1]);

                logger.debug("Found price " + price + " for outbound flight " + flightConfig.outboundFlightNumber);
                outboundFares.push(price);
              }
            }
          }
        })
      ]
    })
    .set({
      return: [
        osmosis
        .find("table[@id='faresReturn']/tbody/tr")
        .then((returnData) => {
          const flights = returnData.find(".js-flight-performance");

          // Loop through all the return flights and find the flight number
          // we are interested in
          for (let flight of flights) {
            const matches = flight.text().match(/\d+/);
            const flightNumber = matches[0];

            // we found the right flight number row - parse the prices for this row
            if (flightNumber == flightConfig.returnFlightNumber) {
              const prices = returnData.find(".product_price");
              for (let rawPrice of prices) {
                const priceMatch = rawPrice.toString().match(/\$.*?(\d+)/);
                const price = parseInt(priceMatch[1]);

                logger.debug("Found price " + price + " for return flight " + flightConfig.returnFlightNumber);
                returnFares.push(price);
              }
            }
          }
        })
      ]
    })
    .done(() => {
      const outboundPrice = parseInt(flightConfig.outboundPrice);
      const returnPrice = parseInt(flightConfig.returnPrice);
      const lowestOutboundFare = Math.min(...outboundFares);
      const lowestReturnFare = Math.min(...returnFares);
      logger.debug('Lowest outbound price for flight number ' + flightConfig.outboundFlightNumber + ' is ' + lowestOutboundFare);
      logger.debug('Configured outbound price for flight ' + flightConfig.outboundFlightNumber + ' is ' + outboundPrice);
      logger.debug('Lowest return price for flight number ' + flightConfig.returnFlightNumber + ' is ' + lowestReturnFare);
      logger.debug('Configured return price for flight ' + flightConfig.returnFlightNumber + ' is ' + returnPrice);

      if (lowestOutboundFare < outboundPrice) {
        const message = "Price Drop: Outbound flight #" + flightConfig.outboundFlightNumber + " " +
          flightConfig.originAirport + "->" + flightConfig.destinationAirport +
          " is now $" + lowestOutboundFare + " (was $" + flightConfig.outboundPrice + ")";
        notify(message);

        // update fare price in config
        flightConfig.outboundPrice = lowestOutboundFare;
      }

      if (lowestReturnFare < returnPrice) {
        const message = "Price Drop: Return flight #" + flightConfig.returnFlightNumber + " " +
          flightConfig.destinationAirport + "->" + flightConfig.originAirport +
          " is now $" + lowestReturnFare + " (was $" + flightConfig.returnPrice + ")";
        notify(message);

        // update fare price in config
        flightConfig.returnPrice = lowestReturnFare;
      }

      updatedFlights.push(flightConfig);
      cb();
    })
}

// main
async.series([
  function(next) {
    async.each(config.flights, function(flight, cb) {
      checkSouthwest(flight, cb);
    }, next);
  },
  function(next) {
    // Update our yml with any new prices and re-generate it
    config.flights = updatedFlights;
    try {
      fs.writeFileSync(configFile, yaml.safeDump(config), 'utf8');
    } catch (e) {
      console.log(e);
      process.exit(-1);
    }
    logger.info("All done checking flight prices and updating config file");
    next();
  }
]);
