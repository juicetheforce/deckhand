/**
 * A fake of KDE's powerdevil on a private bus: PolicyAgent's ActiveInhibitions,
 * announcing each change as the real one does (measured on Plasma 6.8):
 * PropertiesChanged with the property invalidated and no value.
 *
 *   const kde = await startFakePowerdevil(busAddress);
 *   kde.set([['idle', 'firefox', 'video', 'block', 3]]);
 *   await kde.stop();     // the name goes away
 */
import dbus from 'dbus-next';

const { Interface, ACCESS_READ } = dbus.interface;
const NAME = 'org.kde.Solid.PowerManagement.PolicyAgent';

class PolicyAgent extends Interface {
  constructor() {
    super(NAME);
    this._rows = [];
  }
  get ActiveInhibitions() {
    return this._rows;
  }
}
PolicyAgent.configureMembers({ properties: { ActiveInhibitions: { signature: 'a(ssssu)', access: ACCESS_READ } } });

export async function startFakePowerdevil(busAddress) {
  const bus = dbus.sessionBus({ busAddress });
  const agent = new PolicyAgent();
  bus.export('/org/kde/Solid/PowerManagement/PolicyAgent', agent);
  await bus.requestName(NAME, 0);
  return {
    set(rows) {
      agent._rows = rows;
      Interface.emitPropertiesChanged(agent, {}, ['ActiveInhibitions']);
    },
    async stop() {
      await bus.releaseName(NAME);
      bus.disconnect();
    },
  };
}
