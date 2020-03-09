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
    if (this.config.hidelearn == false) {
      LoadedAccessories.push(
        new MiRemoteirLearn(this, this.config.learnconfig)
      );
    }
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
    minTemperature: "16",
    maxTemperature: "30",
    defaultTemperature: "26",
    onoffstate: 0,
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
    const services = [];
    const tokensan = ACInstance.token.substring(ACInstance.token.length - 8);
    const infoService = new Service.AccessoryInformation();
    infoService
      .setCharacteristic(Characteristic.Manufacturer, "Electrolux")
      .setCharacteristic(Characteristic.Model, "Arctic")
      .setCharacteristic(Characteristic.SerialNumber, tokensan);
    services.push(infoService);
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
    ).on("get", callback => callback(null, ACInstance.onoffstate));
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.TargetHeatingCoolingState
    )
      .on("get", callback => {
        callback(null, ACInstance.onoffstate);
      })
      .on("set", (value, callback) => {
        let sstatus = ACInstance.SendData(value, ACInstance.targetTemperature);
        sstatus = sstatus.state;
        ACInstance.onoffstate = sstatus;
        ACInstance.platform.log.debug(
          `[${ACInstance.name}] AirConditioner: Status ${ACInstance.getACMode(
            sstatus
          )}`
        );
        callback(null, sstatus);
      });
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.CurrentTemperature
    ).on("get", callback => {
      callback(null, ACInstance.targetTemperature);
    });
    MiRemoteAirConditionerServices.getCharacteristic(
      Characteristic.TargetTemperature
    )
      .on("get", callback => {
        callback(null, ACInstance.targetTemperature);
      })
      .on("set", (value, callback) => {
        ACInstance.platform.log.info(ACInstance.onoffstate);
        if (ACInstance.onoffstate !== 0) {
          var tem = ACInstance.SendData(ACInstance.onoffstate, value);
        }
        ACInstance.targetTemperature =
          ACInstance.onoffstate !== 0 ? tem.tem : value;
        ACInstance.MiRemoteAirConditionerService.setCharacteristic(
          Characteristic.CurrentTemperature,
          ACInstance.targetTemperature
        );
        ACInstance.platform.log.debug(
          `[${ACInstance.name}]AirConditioner: Temperature ${ACInstance.targetTemperature}`
        );
        callback(null, tem);
      });

    services.push(MiRemoteAirConditionerServices);
    return services;
  };

  ACInstance.getACMode = state => {
    switch (state) {
      case Characteristic.TargetHeatingCoolingState.AUTO:
        return ACInstance.onoffstate === 0 ? "Auto" : "AutoOn";
      case Characteristic.TargetHeatingCoolingState.COOL:
        return ACInstance.onoffstate === 0 ? "Cool" : "CoolOn";
      case Characteristic.TargetHeatingCoolingState.HEAT:
        return ACInstance.onoffstate === 0 ? "Heat" : "HeatOn";
      default:
        return ACInstance.onoffstate === 0 ? "doNothing" : "off";
    }
  };

  ACInstance.SendData = (state, value) => {
    if (!value) value = ACInstance.defaultTemperature;
    const sstatus = ACInstance.getACMode(state);
    let datas = { tem: value };
    if (sstatus == "off") {
      datay = ACInstance.data.off;
    } else if (sstatus == "Auto") {
      if (ACInstance.data.Auto != null) {
        datas = ACInstance.GetDataString(ACInstance.data[sstatus], value);
        var datay = datas.data;
      } else {
        datay = ACInstance.data.off;
        state = 0;
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
      }
    } else {
      datas = ACInstance.GetDataString(ACInstance.data[sstatus], value);
      var datay = datas.data;
    }
    if (datay !== "" && ACInstance.readydevice) {
      ACInstance.device
        .call("miIO.ir_play", { freq: 38400, code: datay })
        .then(() => {
          ACInstance.platform.log.debug(
            `[${ACInstance.name}]AirConditioner: Send Success`
          );
        })
        .catch(err => {
          ACInstance.platform.log.error(
            `[${ACInstance.name}][ERROR]AirConditioner Error: ${err}`
          );
          state = ACInstance.onoffstate;
        });
    } else {
      ACInstance.platform.log.info(
        `[${ACInstance.name}] AirConditioner: Unready`
      );
    }
    const temm = datas.tem || value;
    return { state, tem: temm };
  };

  ACInstance.GetDataString = (dataa, value) => {
    let returnkey = ACInstance.targetTemperature;
    if (dataa[value]) {
      returnkey = value;
    } else {
      let min = ACInstance.minTemperature;
      let max = ACInstance.maxTemperature;
      for (let i = value; i > ACInstance.minTemperature; i -= 1) {
        if (dataa[i]) {
          min = i;
          i = -1;
        }
      }
      for (let i = value; i <= ACInstance.maxTemperature; i += 1) {
        if (dataa[i]) {
          max = i;
          i = 101;
        }
      }
      if (min > ACInstance.minTemperature && max < ACInstance.maxTemperature) {
        const vmin = value - min;
        const vmax = max - value;
        returnkey = vmin > vmax ? min : max;
      } else {
        returnkey = ACInstance.defaultTemperature;
        ACInstance.platform.log.error(
          `[${ACInstance.name}]AirConditioner: Illegal Temperature, Unisset: ${value} Use ${returnkey} instead`
        );
      }
    }
    return { data: dataa[returnkey], tem: returnkey };
  };
  ACInstance.startPingingDevice = period => {
    setInterval(async () => {
      ACInstance.platform.log.debug("AirConditioner keep alive");
      try {
        await ACInstance.device.call("miIO.ir_play", {
          freq: 38400,
          code: "dummy"
        });
        ACInstance.platform.platform.log.debug("AirConditioner SUCCESS");
      } catch (err) {
        ACInstance.platform.log.debug("AirConditioner FAIL");
      }
    }, period);
  };

  ACInstance.startPingingDevice(HALF_A_MUNUTE);

  return ACInstance;
};
