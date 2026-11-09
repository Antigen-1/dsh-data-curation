;; Long-lived Chez guest for the Phase 1 online-VM spike.
;; Wire format: <payload-byte-length>\n<payload>\n, one exchange at a time.
;; Payloads are ASCII JSON, so Chez string length equals UTF-8 byte length.
;; Request payload: (request "id" op arg...). Response payload: JSON object.
;; No REPL prompt, no per-request restart, no stdin EOF until shutdown.
(import (chezscheme))

(define state 0)

(define (json-escape s)
  (let ((out (open-output-string)))
    (for-each
      (lambda (c)
        (cond
          ((char=? c #\") (display "\\\"" out))
          ((char=? c #\\) (display "\\\\" out))
          ((char=? c #\newline) (display "\\n" out))
          ((char=? c #\return) (display "\\r" out))
          ((char=? c #\tab) (display "\\t" out))
          (else (write-char c out))))
      (string->list s))
    (get-output-string out)))

(define (write-frame payload)
  (display (number->string (string-length payload)))
  (newline)
  (display payload)
  (newline)
  (flush-output-port (current-output-port)))

(define (respond id ok value)
  (write-frame
    (string-append
      "{\"id\":\"" (json-escape id) "\",\"ok\":" (if ok "true" "false")
      ",\"value\":" value "}")))

(define (read-n n)
  (let loop ((i 0) (chars '()))
    (if (= i n)
        (list->string (reverse chars))
        (let ((c (read-char (current-input-port))))
          (if (eof-object? c)
              (error 'unexpected-eof "unexpected EOF")
              (loop (+ i 1) (cons c chars)))))))

(define (read-frame)
  (let ((header (get-line (current-input-port))))
    (if (eof-object? header)
        #f
        (let ((n (string->number header)))
          (if (not n)
              (error 'bad-frame-length (format "bad frame length: ~a" header))
              (let ((payload (read-n n)))
                (let ((newline (read-char (current-input-port))))
                  (unless (and newline (char=? newline #\newline))
                    (error 'bad-frame-terminator "bad frame terminator"))
                  payload)))))))

(define (handle req)
  (if (not (and (pair? req) (eq? (car req) 'request) (>= (length req) 3)))
      (respond "?" #f "\"bad request\"")
      (let* ((id (cadr req))
             (op (caddr req))
             (arg (if (>= (length req) 4) (cadddr req) #f)))
        (case op
          ((set)
           (if (number? arg)
               (begin (set! state arg) (respond id #t (number->string state)))
               (respond id #f "\"set requires a number\"")))
          ((get) (respond id #t (number->string state)))
          ((inc)
           (let ((delta (if (number? arg) arg 1)))
             (set! state (+ state delta))
             (respond id #t (number->string state))))
          ((hang)
           (let loop () (loop)))
          ((exit)
           (exit (if (number? arg) arg 0)))
          ((oom)
           (make-vector 100000000 0)
           (respond id #t "0"))
          (else (respond id #f "\"unknown op\""))))))

(write-frame "{\"ready\":true}")

(let loop ()
  (let ((payload (read-frame)))
    (if (not payload)
        (write-frame "{\"eof\":true}")
        (begin
          (guard (e (#t (respond "?" #f (string-append "\"" (json-escape (format "~a" e)) "\""))))
            (handle (read (open-input-string payload))))
          (loop)))))
