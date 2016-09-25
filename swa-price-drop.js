"use strict"

const async = require('async');
const yaml = require('js-yaml');
const fs = require('fs');
const osmosis = require('osmosis');
const twilio = require('twilio');
const winston = require('winston');
const path = require('path');
const os = require('os');
const moment = require('moment');

if (process.argv.length <= 2) {
  console.log('Usage: \n' +
    'node ' + __filename + ' [options] \n\n' +

    'Options: \n' +
    '    --config [/path/to/swa-price-drop.yml]            Path to configuration file (REQUIRED) \n' +
    '    --log [/path/to/log/file.log]                     Path to log file (defaults to $HOME/swa-price-drop.log) \n' +
    '    --loglevel [error/warn/info/verbose/debug/silly]  Log level (defaults to info)');
  process.exit(-1);
}

var configFile;
var config;
var logfile = path.resolve(os.homedir(), 'swa-price-drop.log');
var loglevel = 'info';

var rewriteYamlConfig = false; // do we need to re-write the conig yaml because of an updated price?
var updatedFlights = [];

process.argv.forEach((arg, i, argv) => {
  switch (arg) {
    case '--config':
      configFile = argv[i + 1];
      try {
        config = yaml.safeLoad(fs.readFileSync(configFile, 'utf8'));
      } catch (e) {
        console.log(e);
        process.exit(-1);
      }
      break;
    case '--log':
      logfile = argv[i + 1];
      break;
    case '--loglevel':
      loglevel = argv[i + 1];
      break;
  }
});

var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.File)({
      timestamp: true,
      json: false,
      level: loglevel,
      filename: logfile
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
    } catch(e) {
      logger.error(e);
    }
  }

  // log the price drop
  logger.info(message);
}

const checkSouthwest = (flightConfig, cb) => {
  var now = moment();
  var outboundDate = moment(flightConfig.outboundDate, "MM-DD-YYYY");
  if (moment().isAfter(outboundDate)) {
    // we are past the day of this outbound date so drop this trip from future checks
    rewriteYamlConfig = true;
    logger.info("Removing " + JSON.stringify(flightConfig) + " from future checks because it is past " + flightConfig.outboundDate);
    cb();
  } else {
    const outboundFares = [];
    const returnFares = [];

    logger.info("Checking southwest.com for prices with parameters:\n" +
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

                  logger.debug("Found price " + price + " for outbound flight " + flightConfig.outboundFlightNumber + " on " + flightConfig.outboundDate);
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

                  logger.debug("Found price " + price + " for return flight " + flightConfig.returnFlightNumber + " on " + flightConfig.returnDate);
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
        logger.debug('Notification threshold outbound price for flight ' + flightConfig.outboundFlightNumber + ' is ' + outboundPrice);
        logger.debug('Lowest return price for flight number ' + flightConfig.returnFlightNumber + ' is ' + lowestReturnFare);
        logger.debug('Notification threshold return price for flight ' + flightConfig.returnFlightNumber + ' is ' + returnPrice);

        if (lowestOutboundFare < outboundPrice) {
          const message = "Price Drop: Outbound flight #" + flightConfig.outboundFlightNumber + " " +
            flightConfig.originAirport + "->" + flightConfig.destinationAirport +
            " on " + flightConfig.outboundDate +
            " is now $" + lowestOutboundFare + " (was $" + flightConfig.outboundPrice + ")";
          notify(message);

          // update fare price in config
          flightConfig.outboundPrice = lowestOutboundFare;
          // flag to indicate we need to re-write yaml config
          rewriteYamlConfig = true;
        }

        if (lowestReturnFare < returnPrice) {
          const message = "Price Drop: Return flight #" + flightConfig.returnFlightNumber + " " +
            flightConfig.destinationAirport + "->" + flightConfig.originAirport +
            " on " + flightConfig.returnDate +
            " is now $" + lowestReturnFare + " (was $" + flightConfig.returnPrice + ")";
          notify(message);

          // update fare price in config
          flightConfig.returnPrice = lowestReturnFare;
          // flag to indicate we need to re-write yaml config
          rewriteYamlConfig = true;
        }

        updatedFlights.push(flightConfig);
        cb();
      })
  }
}

// main
async.series([
  function(next) {
    async.each(config.flights, function(flight, cb) {
      checkSouthwest(flight, cb);
    }, next);
  },
  function(next) {
    if (rewriteYamlConfig) {
      // Rewrite the yaml config with updated price(s)
      config.flights = updatedFlights;
      try {
        fs.writeFileSync(configFile, yaml.safeDump(config), 'utf8');
      } catch (e) {
        console.log(e);
        process.exit(-1);
      }
      next();
    } else {
      next();
    }
  }
]);
