import type { SavedDevice } from '../devices/store';
import { modelLabel } from '../devices/model';

/** The model to show next to a TV's name, unless the TV is already named after it ("LG C4 (LG C4)"). */
export function distinctModel(device: Pick<SavedDevice, 'name' | 'info'>): string | undefined {
  const model = modelLabel(device.info?.modelName);
  return model && model.trim().toLowerCase() !== device.name.trim().toLowerCase() ? model : undefined;
}

/** A TV's name in bold, with its model in brackets: **Living Room** (LG C4). */
export function TvName({ device }: { device: Pick<SavedDevice, 'name' | 'info'> }) {
  const model = distinctModel(device);
  return (
    <>
      <b>{device.name}</b>
      {model && <> ({model})</>}
    </>
  );
}
