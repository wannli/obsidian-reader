import type { ClippingBinding } from '../../core/clippings';
import type { FileclassBridge } from './fileclass';
import { validateSettings, type NodesSettings } from './settings';

export async function clippingSettings(
  backend: FileclassBridge,
  next: NodesSettings,
): Promise<NodesSettings> {
  if (!next.clippingType) return { ...next };
  const token = backend.token();
  const binding = {
    property: backend.bindingProperty(next.classProperty),
    type: next.clippingType,
  };
  if (binding.property === 'origin')
    throw new Error('The Fileclass binding property cannot also be origin.');
  const types = await backend.types();
  if (!types.some((type) => type.name === binding.type))
    throw new Error('The chosen clipping Fileclass is unavailable.');
  await backend.assertClippingType(binding.type, binding.property);
  if (backend.token() !== token)
    throw new Error('Fileclass reloaded during clipping setup. Try again.');
  const bindings = [...(next.clippingBindings ?? [])];
  if (!bindings.some((item) => item.type === binding.type && item.property === binding.property))
    bindings.push(binding);
  const result = { ...next, clippingBindings: bindings };
  const invalid = validateSettings(result);
  if (invalid) throw new Error(invalid);
  return result;
}
export async function clippingSession(
  backend: FileclassBridge,
  settings: () => NodesSettings,
  signal: AbortSignal,
) {
  const current = { ...settings() },
    token = backend.token();
  if (!current.clippingType)
    throw new Error(
      'Choose a default clipping Fileclass in Reader settings before keeping passages.',
    );
  const binding: ClippingBinding = {
    property: backend.bindingProperty(current.classProperty),
    type: current.clippingType,
  };
  if (
    !current.clippingBindings?.some(
      (item) => item.property === binding.property && item.type === binding.type,
    )
  )
    throw new Error(
      'Fileclass binding changed. Reapply clipping setup before capturing; existing notes were not changed.',
    );
  const check = () => {
    if (signal.aborted) throw new Error('Clipping capture cancelled.');
    if (
      JSON.stringify(settings()) !== JSON.stringify(current) ||
      backend.token() !== token ||
      backend.bindingProperty(current.classProperty) !== binding.property
    )
      throw new Error('Clipping settings or Fileclass changed. Reopen the passage and retry.');
  };
  const validate = async () => {
    check();
    const types = await backend.types();
    check();
    if (!types.some((type) => type.name === binding.type))
      throw new Error('The clipping Fileclass is no longer available.');
    await backend.assertClippingType(binding.type, binding.property);
    check();
  };
  await validate();
  return {
    binding,
    folder: current.nodesFolder,
    check,
    validate,
    async verify(path: string) {
      check();
      await backend.verifyClipping(path, binding.type, signal);
      check();
    },
  };
}
