const { data } = require("./ElectroluxComands.json");
const miio = require("miio");
const { version } = require("./package.json");
let HomebridgeAPI;

const HALF_A_MUNUTE = 38400;

const checkPlatformConfig = (homebridge, platform) => {
  const { platforms } = require(`${homebridge.user.configPath()}`);
  return Object.values(platforms).some(
    ({ platform: currentPlatform }) => currentPlatform === platform
  );
};

module.exports = function(homebridge) {
  if (!checkPlatformConfig(homebridge, "miIRPlatform")) return;
  HomebridgeAPI = homebridge;
  HomebridgeAPI.registerPlatform(
    "homebridge-mi-ir-remote",
    "miIRPlatform",
    MiIRPlatform,
    true
  );
};

class MiIRPlatform {
  constructor(log, config, api) {
    if (config == null) {
      return;
    }
    this.HomebridgeAPI = HomebridgeAPI;
    this.log = log;
    this.config = config;
    this.api = api;

    this.api.on(
      "didFinishLaunching",
      function() {
        this.log.info("Done!");
      }.bind(this)
    );

    this.log.info("Loading v%s ", version);
  }

  accessories(callback) {
    const LoadedAccessories = [];
    const { deviceCfgs } = this.config;

    if (deviceCfgs instanceof Array) {
      for (let i = 0; i < deviceCfgs.length; i++) {
        const deviceCfg = deviceCfgs[i];
        if (deviceCfg.type && deviceCfg.token) {
          deviceCfg.type === "AirConditioner"
            ? LoadedAccessories.push(MiRemoteAirConditioner(this, deviceCfg))
            : this.log.error(`device type: ${deviceCfg.type}Unexist!`);
        }
      }
      this.log.info(`Loaded accessories: ${LoadedAccessories.length}`);
    }

    callback(LoadedAccessories);
  }
}

const MiRemoteAirConditioner = (platform, config) => {
  platform.log.debug(
    `[MiRemoteAirConditioner]Initializing MiRemoteAirConditioner: ${config.ip}`
  );
  const ACInstance = {
    minTemperature: 16,
    maxTemperature: 30,
    defaultTemperature: 26,
    currentMode: 0,
    targetTemperature: config.defaultTemperature,
    ...config,
    platform,
    readydevice: false,
    data
  };

  miio
    .device({ address: ACInstance.ip, token: ACInstance.token })
    .then(device => {
      ACInstance.device = device;
      ACInstance.readydevice = true;
    })
    .catch(e => platform.log.error("couldnt add device"));

  const Service = platform.HomebridgeAPI.hap.Service;
  const Characteristic = platform.HomebridgeAPI.hap.Characteristic;

  ACInstance.getServices = () => {
    const tokensan = ACInstance.token.substring(ACInstance.token.length - 8);
    const infoService = new Service.AccessoryInformation();
    infoService
      .setCharacteristic(Characteristic.Manufacturer, "Electrolux")
      .setCharacteristic(Characteristic.Model, "Arctic")
      .setCharacteristic(Characteristic.SerialNumber, tokensan);

    ACInstance.MiRemoteAirConditionerService = new Service.Thermostat(
      ACInstance.name,
      "Electrolux"
    );
    const MiRemoteAirConditionerServices =
      ACInstance.MiRemoteAirConditionerService;
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.TargetTemperature
    ).setProps({
      minValue: ACInstance.minTemperature,
      maxValue: ACInstance.maxTemperature,
      minStep: 1
    });
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.TemperatureDisplayUnits
    ).on("get", callback =>
      callback(Characteristic.TemperatureDisplayUnits.CELSIUS)
    );
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.CurrentHeatingCoolingState
    ).on("get", callback => callback(null, ACInstance.currentMode));
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.TargetHeatingCoolingState
    )
      .on("get", ACInstance.onGetTargetHeatingCoolingState)
      .on("set", ACInstance.onSetTargetHeatingCoolingState);
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.CurrentTemperature
    ).on("get", callback => {
      callback(null, ACInstance.targetTemperature);
    });
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.TargetTemperature
    )
      .on("get", ACInstance.onGetTargetTemperature)
      .on("set", ACInstance.onSetTargetTemperature);

    return [infoService, MiRemoteAirConditionerServices];
  };

  ACInstance.onGetTargetHeatingCoolingState = callback => {
    callback(null, ACInstance.currentMode);
  };

  ACInstance.onSetTargetHeatingCoolingState = (value, callback) => {
    let status = ACInstance.SendData(value, ACInstance.targetTemperature);
    status = status.state;
    ACInstance.currentMode = status;
    ACInstance.platform.log.debug(
      `[${ACInstance.name}] AirConditioner: Status ${ACInstance.getACMode(
        status
      )}`
    );
    callback(null, status);
  };

  ACInstance.onGetTargetTemperature = callback => {
    callback(null, ACInstance.targetTemperature);
  };

  ACInstance.onSetTargetTemperature = (value, callback) => {
    if (ACInstance.currentMode !== 0) {
      var tem = ACInstance.SendData(ACInstance.currentMode, value);
    }
    ACInstance.targetTemperature =
      ACInstance.currentMode !== 0 ? tem.tem : value;
    ACInstance.MiRemoteAirConditionerService.setCharacteristic(
      Characteristic.CurrentTemperature,
      ACInstance.targetTemperature
    );
    ACInstance.platform.log.debug(
      `[${ACInstance.name}]AirConditioner: Temperature ${ACInstance.targetTemperature}`
    );
    callback(null, tem);
  };

  ACInstance.getACMode = state => {
    switch (state) {
      case Characteristic.TargetHeatingCoolingState.AUTO:
        return !ACInstance.currentMode ? "Auto" : "AutoOn";
      case Characteristic.TargetHeatingCoolingState.COOL:
        return !ACInstance.currentMode ? "Cool" : "CoolOn";
      case Characteristic.TargetHeatingCoolingState.HEAT:
        return !ACInstance.currentMode ? "Heat" : "HeatOn";
      default:
        return !ACInstance.currentMode ? "doNothing" : "off";
    }
  };

  ACInstance.SendData = (state, temperature) => {
    if (!temperature) temperature = ACInstance.defaultTemperature;
    const status = ACInstance.getACMode(state);
    const data = { temperature, state };
    const code = ACInstance.getCodeIsGoingToBeSend(status, data);

    if (code && ACInstance.readydevice) {
      ACInstance.device
        .call("miIO.ir_play", { freq: 38400, code })
        .then(() => {
          ACInstance.platform.log.debug(
            `[${ACInstance.name}]AirConditioner: Send Success`
          );
        })
        .catch(err => {
          ACInstance.platform.log.error(
            `[${ACInstance.name}][ERROR]AirConditioner Error: ${err}`
          );
          data.state = ACInstance.currentMode;
        });
    } else {
      ACInstance.platform.log.info(
        `[${ACInstance.name}] AirConditioner: Unready`
      );
    }
    return { state, tem: data.temperature ? data.temperature : temperature };
  };

  ACInstance.getCodeIsGoingToBeSend = (status, data) => {
    switch (status) {
      case "off":
      case "doNothing":
        data.code = ACInstance.data[status];
        break;
      case "Auto":
        if (!ACInstance.data.Auto) {
          data.code = ACInstance.data.off;
          data.state = 0;
          setTimeout(() => {
            ACInstance.MiRemoteAirConditionerService.setCharacteristic(
              Characteristic.CurrentHeatingCoolingState,
              0
            );
            ACInstance.MiRemoteAirConditionerService.setCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              0
            );
          }, 0.6 * 1000);
          break;
        }
      default:
        data = {
          ...data,
          ...ACInstance.GetDataString(ACInstance.data[status], data.temperature)
        };
    }
    return data.code;
  };

  ACInstance.GetDataString = (data, value) => {
    let returnkey = ACInstance.targetTemperature;
    if (data[value]) returnkey = value;
    return { code: data[returnkey], temperature: returnkey };
  };
  //AirConditioner keep alive
  setInterval(async () => {
    try {
      await ACInstance.device.call("miIO.ir_play", {
        freq: 38400,
        code: "dummy"
      });
      ACInstance.platform.log.debug("AirConditioner SUCCESS");
    } catch (err) {
      ACInstance.platform.log.debug("AirConditioner FAIL");
    }
  }, HALF_A_MUNUTE);

  return ACInstance;
};
