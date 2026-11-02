# Synthetic calibration performance fixture

Command (Linux arm64, local CAMPPlus ONNX model):

```sh
FIXTURE_DIR=/opt/data/cache/scratch node scripts/fixtures/benchmark-in-app-calibration.js /opt/data/cache/scratch/openwhispr-calibration-model/campplus.onnx 400
```

The fixture creates 12 notes, 3 invented people, and 400 reviewed rows. Three synthetic 2-second sine-wave clips are encoded to 32 kb/s Opus and decoded once. The model then re-embeds each row while the script reads the compressed clip bytes for each row. This measures model inference and repeated compressed-byte reads. It does **not** measure the app's encrypted chunk decryption, Opus decoding per row, note loading, or UI IPC, so it is a lower bound on full in-app runtime. Its scores are meaningless for real speakers and the report is synthetic, with every parameter uncalibrated.

Observed output:

```text
notes=12 people=3 reviewedRows=400 reembeddedRows=400
bytesRead=3358800 elapsedMs=181098 secondsPerRow=0.452745
report.synthetic=true exactClusters=36 estimatedRows=400
report.exact.winner={"similarityFloor":0.75,"runnerUpMargin":0.1,"right":36,"wrong":0,"refused":0}
report.support={"similarityFloor":"uncalibrated","runnerUpMargin":"uncalibrated","minimumVoicedSeconds":"uncalibrated","overlapToleranceSeconds":"uncalibrated"}
report.recommended={}
```

At a budget of 400 reviewed rows, a two-hour meeting takes at least about **181 seconds** for this model stage on this machine. The full in-app analysis takes longer; its wall time depends on retained chunk layout, decoding and actual reviewed-row count. Meeting duration alone does not determine the job time.
