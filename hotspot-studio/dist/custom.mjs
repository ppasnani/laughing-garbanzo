const blockName = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export function validateCustom(experiment) {
  if (!experiment || experiment.kind !== 'custom_2d_steady' || !Array.isArray(experiment.floorplan))
    return {field: 'experiment', message: 'Import a custom_2d_steady experiment.'};
  if (Object.keys(experiment).sort().join(',') !== 'floorplan,kind,power_w')
    return {field: 'experiment', message: 'Experiment JSON must contain only kind, floorplan, and power_w.'};
  if (experiment.floorplan.length < 1 || experiment.floorplan.length > 128)
    return {field: 'floorplan', message: 'Add 1 to 128 blocks.'};
  const names = new Set();
  for (const [index, block] of experiment.floorplan.entries()) {
    const prefix = `floorplan.${index}`;
    if (!block || Object.keys(block).sort().join(',') !== 'height_m,name,width_m,x_m,y_m')
      return {field: prefix, message: `Block ${index + 1} must contain only name, x_m, y_m, width_m, and height_m.`};
    if (!blockName.test(block.name || '')) return {field: `${prefix}.name`, message: 'Use a unique name beginning with a letter (up to 32 letters, digits, or underscores).'};
    if (names.has(block.name)) return {field: `${prefix}.name`, message: `Duplicate block name: ${block.name}.`};
    names.add(block.name);
    for (const key of ['x_m', 'y_m', 'width_m', 'height_m']) {
      const value = block[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 0.1 ||
          (['width_m', 'height_m'].includes(key) && value === 0))
        return {field: `${prefix}.${key}`, message: `${key} must be a finite ${key.startsWith('x') || key.startsWith('y') ? 'nonnegative' : 'positive'} value within 0.1 m.`};
    }
    if (block.x_m + block.width_m > 0.1 || block.y_m + block.height_m > 0.1)
      return {field: prefix, message: `${block.name} extends beyond 0.1 m.`};
    for (const previous of experiment.floorplan.slice(0, index)) {
      if (block.x_m < previous.x_m + previous.width_m && previous.x_m < block.x_m + block.width_m &&
          block.y_m < previous.y_m + previous.height_m && previous.y_m < block.y_m + block.height_m)
        return {field: prefix, message: `${block.name} overlaps ${previous.name}.`};
    }
  }
  const power = experiment.power_w;
  if (!power || typeof power !== 'object' || Array.isArray(power))
    return {field: 'power_w', message: 'Provide watts for every block.'};
  const missing = [...names].filter(name => !(name in power));
  const extra = Object.keys(power).filter(name => !names.has(name));
  if (missing.length || extra.length)
    return {field: 'power_w', message: `Power names mismatch. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}.`};
  for (const [name, watts] of Object.entries(power)) {
    if (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0 || watts > 10000)
      return {field: `power_w.${name}`, message: `${name} power must be 0 to 10,000 W.`};
  }
  if (Object.values(power).reduce((sum, value) => sum + value, 0) > 100000)
    return {field: 'power_w', message: 'Total power must not exceed 100,000 W.'};
  return null;
}

export function canonicalExperiment(rows) {
  return {
    kind: 'custom_2d_steady',
    floorplan: rows.map(row => Object.fromEntries(['name', 'x_m', 'y_m', 'width_m', 'height_m'].map(key => [key, key === 'name' ? row[key] : row[key] === '' ? NaN : Number(row[key])]))),
    power_w: Object.fromEntries(rows.map(row => [row.name, row.watts === '' ? NaN : Number(row.watts)])),
  };
}
