export class ScrollEngine {
  constructor(settings = {}, timeline = {}, textHeight = 1000) {
    this.speed = Number(timeline.speed ?? settings.scrollSpeed ?? 80);
    this.startDelay = Number(timeline.startDelay ?? settings.startDelay ?? 0);
    this.scrollFirstRow =
      timeline.scrollFirstRow != null
        ? timeline.scrollFirstRow
        : settings.scrollFirstRow;
    this.scrollLastRow =
      timeline.scrollLastRow != null
        ? timeline.scrollLastRow
        : settings.scrollLastRow;
    this.designHeight = 1920;
    this.textHeight = textHeight;
    this.y = 0;
    this.startY = 0;
    this.endY = 0;
  }

  measure(designHeight) {
    this.designHeight = designHeight;
    const dh = designHeight;
    const firstRow = this.scrollFirstRow != null ? this.scrollFirstRow : dh;
    const lastRow = this.scrollLastRow != null ? this.scrollLastRow : 0;
    this.startY = firstRow;
    this.endY = lastRow - this.textHeight;
  }

  getScrollDuration() {
    const distance = this.startY - this.endY;
    return distance > 0 ? distance / this.speed : 0;
  }

  getTotalDuration() {
    return this.startDelay + this.getScrollDuration();
  }

  applyTime(time) {
    const total = this.getTotalDuration();
    const t = Math.max(0, Math.min(time, total));
    if (t < this.startDelay) {
      this.y = this.startY;
    } else {
      const scrollT = t - this.startDelay;
      this.y = Math.max(this.endY, this.startY - scrollT * this.speed);
    }
    return t;
  }
}
