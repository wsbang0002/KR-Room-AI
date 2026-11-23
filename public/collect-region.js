// A receipt allows a reader to resume polling without submitting another paid request.
function regionCollection(request, refresh, expireSession) {
  const panel = document.getElementById('collectionPanel');
  const start = document.getElementById('collectRegion');
  const stop = document.getElementById('stopCollection');
  const feedback = document.getElementById('collectionFeedback');
  let context = null;
  let controller = null;
  let receipt = null;
  let stopAfterReceipt = false;

  function draw() {
    const visible = context?.signedIn && context.conditions?.location;
    panel.hidden = !visible;
    start.disabled = !visible || context.busy || !context.enabled || Boolean(controller);
    start.textContent = receipt ? '수집 상태 다시 확인' : (context?.conditions?.location || '선택 지역') + ' 매물 수집';
    stop.hidden = !controller;
  }

  function update(next) {
    if (!next.signedIn || context?.conditions !== next.conditions) {
      controller?.abort();
      controller = null;
      receipt = null;
      feedback.textContent = '';
    }
    context = next;
    if (next.signedIn && next.conditions && !next.enabled) feedback.textContent = '현재 신규 매물 수집이 꺼져 있어요.';
    draw();
  }

  function pause(signal) {
    return new Promise((resolve, reject) => {
      function abort() {
        clearTimeout(timer);
        reject(new DOMException('조회 중단', 'AbortError'));
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 3000);
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    });
  }

  stop.addEventListener('click', () => {
    if (!receipt && controller) {
      // Keep the response to an already submitted POST so resuming needs only a GET.
      stopAfterReceipt = true;
      stop.disabled = true;
    } else controller?.abort();
    feedback.textContent = '상태 조회를 중단했어요. 이미 시작한 수집은 계속될 수 있어요.';
  });
  start.addEventListener('click', async () => {
    if (start.disabled || !context?.signedIn || !context.conditions) return;
    const {query,conditions} = context;
    if (!receipt && !window.confirm(conditions.location + ' 매물을 최대 20건 수집할까요? 이번 실행 비용 상한은 $0.51이며, 조회를 중단해도 실행 비용이 발생할 수 있어요.')) return;
    const operation = new AbortController();
    controller = operation;
    stopAfterReceipt = false;
    stop.disabled = false;
    draw();
    try {
      if (!receipt) {
        feedback.textContent = '수집 요청을 보내고 있어요.';
        const job = await request('/api/collect', {query, confirmedConditions:conditions}, operation.signal);
        if (operation.signal.aborted) return;
        if (typeof job.jobId !== 'string' || !job.jobId) throw Error('수집 접수 여부를 확인할 수 없어요.');
        receipt = job.jobId;
        if (stopAfterReceipt) return;
      }
      feedback.textContent = '수집 상태를 확인하고 있어요.';
      for (let attempt = 0; attempt < 90; attempt++) {
        const job = await request('/api/collect-status?jobId=' + encodeURIComponent(receipt), undefined, operation.signal);
        if (operation.signal.aborted) return;
        if (job.state === 'SUCCEEDED') {
          receipt = null;
          feedback.textContent = Number.isInteger(job.persistedCount) ? '수집을 마쳤어요. 저장한 매물 ' + job.persistedCount + '건을 반영해 다시 검색합니다.' : '수집을 마쳤어요. 저장 매물을 다시 검색합니다.';
          await refresh();
          return;
        }
        if (['FAILED','ABORTED','TIMED-OUT'].includes(job.state)) {
          receipt = null;
          throw Error('수집이 완료되지 않았어요 (' + job.state + ').');
        }
        if (job.state === 'START_UNCONFIRMED') throw Error('수집 시작 여부를 확인할 수 없어요. 운영 콘솔에서 실행 기록을 확인해 주세요.');
        feedback.textContent = '매물 수집이 진행 중이에요.';
        await pause(operation.signal);
      }
      feedback.textContent = '아직 수집이 끝나지 않았어요. 상태를 다시 확인해 주세요.';
    } catch (error) {
      if (operation.signal.aborted) return;
      if (error.status === 401) { expireSession(); return; }
      feedback.textContent = error instanceof TypeError && !receipt
        ? '요청 접수 여부를 확인할 수 없어요. 수집이 이미 시작됐을 수 있으니 실행 기록을 확인해 주세요.'
        : error.message || '수집 상태를 확인할 수 없어요.';
    } finally {
      if (controller === operation) { controller = null; draw(); }
    }
  });
  return {update};
}
