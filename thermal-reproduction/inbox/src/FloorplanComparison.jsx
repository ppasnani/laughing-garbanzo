import React, { useEffect, useRef, useState } from 'react';
import { Button, Callout, Dialog, DialogBody, DialogFooter, FileInput, FormGroup, Tag } from '@blueprintjs/core';

export default function FloorplanComparison({ paper, onClose }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const requestRef = useRef(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  function chooseFile(event) {
    const selected = event.target.files?.[0];
    setResult(null);
    setError('');
    setFile(null);
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.flp')) {
      setError('Choose a floorplan file with the .flp extension.');
    } else if (selected.size > 1024 * 1024) {
      setError('The floorplan must be at most 1 MiB.');
    } else {
      setFile(selected);
    }
  }

  async function compare() {
    if (!file || busy) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const content = await file.text();
      if (controller.signal.aborted) return;
      const response = await fetch(paper.inputs.compare_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content }), signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'The floorplans could not be compared.');
      setResult(data);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <Dialog isOpen onClose={onClose} title="Compare my Floorplan" icon="comparison"
    className="comparison-dialog" aria-describedby="comparison-description">
    <DialogBody useOverflowScrollContainer>
      <p id="comparison-description" className="comparison-description">
        Compare your layout with the saved input.flp for <strong>{paper.title}</strong>.
      </p>
      <FormGroup label="Your floorplan (.flp)" labelFor="comparison-file"
        helperText="HotSpot format: name, width, height, x, y in metres. Maximum 1 MiB and 1000 blocks.">
        <FileInput fill disabled={busy} hasSelection={Boolean(file)} text={file?.name || 'Choose a .flp file…'}
          inputProps={{ id: 'comparison-file', accept: '.flp', 'aria-label': 'Upload your floorplan' }}
          onInputChange={chooseFile} />
      </FormGroup>
      {error && <Callout intent="danger" role="alert" title="Unable to compare">{error}</Callout>}
      {result && <div className="comparison-result" aria-live="polite">
        <div className="comparison-summary">
          <strong>{result.base_blocks} → {result.uploaded_blocks} blocks</strong>
          {Object.entries(result.counts).map(([kind, count]) => <Tag key={kind} minimal>{count} {kind}</Tag>)}
        </div>
        <iframe className="comparison-viewer" title="Floorplan comparison results"
          srcDoc={result.html} sandbox="" />
      </div>}
    </DialogBody>
    <DialogFooter actions={<>
      <Button onClick={onClose}>Close</Button>
      <Button intent="primary" onClick={compare} disabled={!file || busy} loading={busy}>Compare</Button>
    </>} />
  </Dialog>;
}
