;; Source-tree datum reader + canonical v2 encoding for the Chez experiment.
;; Per the 2026-11-08 decision, this uses Chez `read` and validates the
;; resulting datums. It does not restrict the readtable or reimplement the
;; reader. Resource limits are enforced after `read` has built each datum;
;; containment against a reader-time crash is the supervisor's job.
;;
;; Canonical format (all integers big-endian u32 unless noted):
;;   list       0x01 | count | elements
;;   symbol     0x02 | utf8-length | utf8
;;   string     0x03 | utf8-length | utf8
;;   integer    0x04 | sign (0/1) | decimal-length | decimal ASCII
;;   rational   0x05 | integer(numerator) | integer(denominator)
;;   real       0x06 | 8-byte IEEE-754 double (little-endian canonical)
;;   boolean    0x07 | 0/1
;;   char       0x08 | scalar-value
;;   vector     0x09 | count | elements
;;   bytevector 0x0A | length | bytes
;;   source     0x10 | form-count | forms
;;
;; Hash identity is the canonical datum tree, not the raw source string.

(import (chezscheme))

(define MAX-SOURCE-BYTES 1048576)
(define MAX-DEPTH 256)
(define MAX-FORMS 100000)
(define MAX-LIST 100000)
(define MAX-STRING 1048576)
(define MAX-VECTOR 100000)
(define MAX-BYTEVECTOR 1048576)
(define MAX-NODES 1000000)

(define current-source "")
(define current-rule-id "unknown")
(define current-form-start 0)

(define (offset->line-col source offset)
  (let loop ((i 0) (line 1) (col 1))
    (if (or (>= i offset) (>= i (string-length source)))
        (list line col)
        (let ((ch (string-ref source i)))
          (if (char=? ch #\newline)
              (loop (+ i 1) (+ line 1) 1)
              (loop (+ i 1) line (+ col 1)))))))

(define (skip-block-comment source i depth)
  (let ((n (string-length source)))
    (if (>= i n)
        n
        (let ((a (string-ref source i))
              (b (and (< (+ i 1) n) (string-ref source (+ i 1)))))
          (cond
            ((and (char=? a #\|) b (char=? b #\#))
             (if (= depth 1)
                 (+ i 2)
                 (skip-block-comment source (+ i 2) (- depth 1))))
            ((and (char=? a #\#) b (char=? b #\|))
             (skip-block-comment source (+ i 2) (+ depth 1)))
            (else (skip-block-comment source (+ i 1) depth)))))))

(define (skip-atmosphere source i)
  (let ((n (string-length source)))
    (if (>= i n)
        n
        (let ((ch (string-ref source i)))
          (cond
            ((char-whitespace? ch) (skip-atmosphere source (+ i 1)))
            ((char=? ch #\;)
             (let loop ((j (+ i 1)))
               (if (or (>= j n) (char=? (string-ref source j) #\newline))
                   (skip-atmosphere source j)
                   (loop (+ j 1)))))
            ((and (char=? ch #\#) (< (+ i 1) n) (char=? (string-ref source (+ i 1)) #\|))
             (skip-atmosphere source (skip-block-comment source (+ i 2) 1)))
            (else i))))))

(define (source-fail code message)
  (let ((pos (offset->line-col current-source current-form-start)))
    (raise (list 'source-error code message current-rule-id
                 (car pos) (cadr pos) "v2"))))

(define (validate-datum datum depth seen counter)
  (when (> depth MAX-DEPTH)
    (source-fail "E-DEPTH" "datum nesting exceeds limit"))
  (vector-set! counter 0 (+ (vector-ref counter 0) 1))
  (when (> (vector-ref counter 0) MAX-NODES)
    (source-fail "E-NODES" "datum node count exceeds limit"))
  (cond
    ((boolean? datum) #t)
    ((and (integer? datum) (exact? datum)) #t)
    ((and (rational? datum) (exact? datum)) #t)
    ((real? datum) #t)
    ((char? datum) #t)
    ((string? datum)
     (when (> (string-length datum) MAX-STRING)
       (source-fail "E-STRING" "string exceeds limit"))
     #t)
    ((symbol? datum)
     (when (> (string-length (symbol->string datum)) MAX-STRING)
       (source-fail "E-SYMBOL" "symbol exceeds limit"))
     #t)
    ((bytevector? datum)
     (when (> (bytevector-length datum) MAX-BYTEVECTOR)
       (source-fail "E-BYTEVECTOR" "bytevector exceeds limit"))
     #t)
    ((vector? datum)
     (when (hashtable-contains? seen datum)
       (source-fail "E-CYCLE" "cyclic datum is not allowed"))
     (when (> (vector-length datum) MAX-VECTOR)
       (source-fail "E-VECTOR" "vector exceeds limit"))
     (hashtable-set! seen datum #t)
     (let loop ((i 0))
       (when (< i (vector-length datum))
         (validate-datum (vector-ref datum i) (+ depth 1) seen counter)
         (loop (+ i 1))))
     (hashtable-delete! seen datum)
     #t)
    ((list? datum)
     (when (> (length datum) MAX-LIST)
       (source-fail "E-LIST" "list exceeds limit"))
     (let loop ((xs datum))
       (unless (null? xs)
         (validate-datum (car xs) (+ depth 1) seen counter)
         (loop (cdr xs))))
     #t)
    ((pair? datum)
     (source-fail "E-DOTTED" "improper list is not allowed"))
    (else
     (source-fail "E-DATUM" "unsupported datum type"))))

(define (read-source source . rule-id-arg)
  (let ((rule-id (if (null? rule-id-arg) "unknown" (car rule-id-arg))))
    (set! current-source source)
    (set! current-rule-id (if (string? rule-id) rule-id (symbol->string rule-id)))
    (when (> (bytevector-length (string->utf8 source)) MAX-SOURCE-BYTES)
      (source-fail "E-SOURCE" "source exceeds byte limit"))
    (let ((port (open-string-input-port source))
          (seen (make-eq-hashtable))
          (counter (vector 0)))
      (let loop ((forms '()) (n 0))
        (set! current-form-start (skip-atmosphere source (port-position port)))
        (let ((datum
               (call/cc
                 (lambda (escape)
                   (with-exception-handler
                     (lambda (e) (escape 'read-error))
                     (lambda () (read port)))))))
          (if (eq? datum 'read-error)
              (source-fail "E-READ" "reader rejected source")
              (if (eof-object? datum)
                  (reverse forms)
                  (begin
                    (when (>= n MAX-FORMS)
                      (source-fail "E-FORMS" "too many top-level forms"))
                    (validate-datum datum 0 seen counter)
                    (loop (cons datum forms) (+ n 1))))))))))

;; ---------------------------------------------------------------------------
;; Canonical encoder
;; ---------------------------------------------------------------------------

(define (list->bytevector items)
  (let* ((n (length items)) (out (make-bytevector n 0)))
    (let loop ((i 0) (xs items))
      (when (< i n)
        (bytevector-u8-set! out i (car xs))
        (loop (+ i 1) (cdr xs))))
    out))

(define (put-u32 out n)
  (put-u8 out (bitwise-and (bitwise-arithmetic-shift-right n 24) #xFF))
  (put-u8 out (bitwise-and (bitwise-arithmetic-shift-right n 16) #xFF))
  (put-u8 out (bitwise-and (bitwise-arithmetic-shift-right n 8) #xFF))
  (put-u8 out (bitwise-and n #xFF)))

(define (put-utf8 out s)
  (let ((bv (string->utf8 s)))
    (put-u32 out (bytevector-length bv))
    (put-bytevector out bv)))

(define (put-integer out n)
  (put-u8 out #x04)
  (put-u8 out (if (< n 0) 1 0))
  (let* ((magnitude (if (< n 0) (- n) n))
         (digits (string->utf8 (number->string magnitude 10))))
    (put-u32 out (bytevector-length digits))
    (put-bytevector out digits)))

(define (native-little-endian?)
  (let ((bv (make-bytevector 2 0)))
    (bytevector-u16-native-set! bv 0 #x0102)
    (= (bytevector-u8-ref bv 0) #x02)))

(define (reverse-bytevector bv)
  (let* ((n (bytevector-length bv)) (out (make-bytevector n 0)))
    (let loop ((i 0))
      (when (< i n)
        (bytevector-u8-set! out i (bytevector-u8-ref bv (- n 1 i)))
        (loop (+ i 1))))
    out))

(define (double-bytes x)
  (if (not (= x x))
      (bytevector 0 0 0 0 0 0 248 127)
      (let ((bv (make-bytevector 8 0)))
        (bytevector-ieee-double-native-set! bv 0 x)
        (if (native-little-endian?) bv (reverse-bytevector bv)))))

(define (emit-datum out v)
  (cond
    ((eq? v #t) (put-u8 out #x07) (put-u8 out 1))
    ((eq? v #f) (put-u8 out #x07) (put-u8 out 0))
    ((null? v) (put-u8 out #x01) (put-u32 out 0))
    ((and (integer? v) (exact? v)) (put-integer out v))
    ((and (rational? v) (exact? v))
     (put-u8 out #x05)
     (put-integer out (numerator v))
     (put-integer out (denominator v)))
    ((and (real? v) (inexact? v))
     (put-u8 out #x06)
     (put-bytevector out (double-bytes v)))
    ((symbol? v) (put-u8 out #x02) (put-utf8 out (symbol->string v)))
    ((string? v) (put-u8 out #x03) (put-utf8 out v))
    ((char? v) (put-u8 out #x08) (put-u32 out (char->integer v)))
    ((bytevector? v)
     (put-u8 out #x0A)
     (put-u32 out (bytevector-length v))
     (put-bytevector out v))
    ((vector? v)
     (put-u8 out #x09)
     (put-u32 out (vector-length v))
     (let loop ((i 0))
       (when (< i (vector-length v))
         (emit-datum out (vector-ref v i))
         (loop (+ i 1)))))
    ((pair? v)
     (if (list? v)
         (begin
           (put-u8 out #x01)
           (put-u32 out (length v))
           (for-each (lambda (x) (emit-datum out x)) v))
         (error 'unsupported-dotted-list v)))
    (else (error 'unsupported-datum v))))

(define (canonical-source-bytes source . rule-id)
  (let ((forms (if (null? rule-id) (read-source source) (read-source source (car rule-id)))))
    (define-values (out get) (open-bytevector-output-port))
    (put-u8 out #x10)
    (put-u32 out (length forms))
    (for-each (lambda (v) (emit-datum out v)) forms)
    (get)))

;; ---------------------------------------------------------------------------
;; SHA-256 (public R6RS bytevector operations)
;; ---------------------------------------------------------------------------

(define MASK #xFFFFFFFF)
(define (u32x n) (bitwise-and n MASK))
(define (add32 . xs) (u32x (apply + xs)))
(define (rotr x n)
  (u32x (bitwise-ior
          (bitwise-arithmetic-shift-right x n)
          (bitwise-arithmetic-shift-left x (- 32 n)))))
(define (shr x n) (bitwise-arithmetic-shift-right x n))
(define (xor3 a b c) (bitwise-xor (bitwise-xor a b) c))
(define (ch x y z) (bitwise-xor (bitwise-and x y) (bitwise-and (bitwise-not x) z)))
(define (maj x y z) (bitwise-xor (bitwise-xor (bitwise-and x y) (bitwise-and x z)) (bitwise-and y z)))

(define K
  (vector
   #x428a2f98 #x71374491 #xb5c0fbcf #xe9b5dba5 #x3956c25b #x59f111f1 #x923f82a4 #xab1c5ed5
   #xd807aa98 #x12835b01 #x243185be #x550c7dc3 #x72be5d74 #x80deb1fe #x9bdc06a7 #xc19bf174
   #xe49b69c1 #xefbe4786 #x0fc19dc6 #x240ca1cc #x2de92c6f #x4a7484aa #x5cb0a9dc #x76f988da
   #x983e5152 #xa831c66d #xb00327c8 #xbf597fc7 #xc6e00bf3 #xd5a79147 #x06ca6351 #x14292967
   #x27b70a85 #x2e1b2138 #x4d2c6dfc #x53380d13 #x650a7354 #x766a0abb #x81c2c92e #x92722c85
   #xa2bfe8a1 #xa81a664b #xc24b8b70 #xc76c51a3 #xd192e819 #xd6990624 #xf40e3585 #x106aa070
   #x19a4c116 #x1e376c08 #x2748774c #x34b0bcb5 #x391c0cb3 #x4ed8aa4a #x5b9cca4f #x682e6ff3
   #x748f82ee #x78a5636f #x84c87814 #x8cc70208 #x90befffa #xa4506ceb #xbef9a3f7 #xc67178f2))

(define (pad-message bv)
  (let* ((len (bytevector-length bv))
         (rem (modulo len 64))
         (pad-len (if (< rem 56) (- 55 rem) (- 119 rem)))
         (total (+ len 1 pad-len 8))
         (out (make-bytevector total 0)))
    (let loop ((i 0))
      (when (< i len)
        (bytevector-u8-set! out i (bytevector-u8-ref bv i))
        (loop (+ i 1))))
    (bytevector-u8-set! out len #x80)
    (let ((bits (* len 8)))
      (let loop ((i 0))
        (when (< i 8)
          (bytevector-u8-set! out (- total 1 i)
            (bitwise-and (bitwise-arithmetic-shift-right bits (* 8 i)) #xFF))
          (loop (+ i 1)))))
    out))

(define (sha256 bv)
  (let* ((msg (pad-message bv))
         (n (/ (bytevector-length msg) 64))
         (h (vector #x6a09e667 #xbb67ae85 #x3c6ef372 #xa54ff53a
                    #x510e527f #x9b05688c #x1f83d9ab #x5be0cd19)))
    (let chunk-loop ((chunk 0))
      (if (= chunk n)
          (let ((out (make-bytevector 32 0)))
            (let loop ((i 0))
              (when (< i 8)
                (let ((word (vector-ref h i)))
                  (bytevector-u8-set! out (+ (* i 4) 0)
                    (bitwise-and (bitwise-arithmetic-shift-right word 24) #xFF))
                  (bytevector-u8-set! out (+ (* i 4) 1)
                    (bitwise-and (bitwise-arithmetic-shift-right word 16) #xFF))
                  (bytevector-u8-set! out (+ (* i 4) 2)
                    (bitwise-and (bitwise-arithmetic-shift-right word 8) #xFF))
                  (bytevector-u8-set! out (+ (* i 4) 3)
                    (bitwise-and word #xFF)))
                (loop (+ i 1))))
            out)
          (let ((w (make-vector 64 0))
                (base (* chunk 64)))
            (let loop ((i 0))
              (when (< i 16)
                (let ((j (+ base (* i 4))))
                  (vector-set! w i
                    (bitwise-ior
                      (bitwise-arithmetic-shift-left (bytevector-u8-ref msg j) 24)
                      (bitwise-arithmetic-shift-left (bytevector-u8-ref msg (+ j 1)) 16)
                      (bitwise-arithmetic-shift-left (bytevector-u8-ref msg (+ j 2)) 8)
                      (bytevector-u8-ref msg (+ j 3)))))
                (loop (+ i 1))))
            (let loop ((i 16))
              (when (< i 64)
                (vector-set! w i
                  (add32 (vector-ref w (- i 16))
                         (u32x (bitwise-xor
                                 (rotr (vector-ref w (- i 15)) 7)
                                 (rotr (vector-ref w (- i 15)) 18)
                                 (shr (vector-ref w (- i 15)) 3)))
                         (vector-ref w (- i 7))
                         (u32x (bitwise-xor
                                 (rotr (vector-ref w (- i 2)) 17)
                                 (rotr (vector-ref w (- i 2)) 19)
                                 (shr (vector-ref w (- i 2)) 10)))))
                (loop (+ i 1))))
            (let ((a (vector-ref h 0)) (b (vector-ref h 1))
                  (c (vector-ref h 2)) (d (vector-ref h 3))
                  (e (vector-ref h 4)) (f (vector-ref h 5))
                  (g (vector-ref h 6)) (hh (vector-ref h 7)))
              (let loop ((i 0))
                (when (< i 64)
                  (let* ((s1 (u32x (bitwise-xor (rotr e 6) (rotr e 11) (rotr e 25))))
                         (chv (ch e f g))
                         (t1 (add32 hh s1 chv (vector-ref K i) (vector-ref w i)))
                         (s0 (u32x (bitwise-xor (rotr a 2) (rotr a 13) (rotr a 22))))
                         (majv (maj a b c))
                         (t2 (add32 s0 majv)))
                    (set! hh g) (set! g f) (set! f e)
                    (set! e (add32 d t1))
                    (set! d c) (set! c b) (set! b a)
                    (set! a (add32 t1 t2)))
                  (loop (+ i 1))))
              (vector-set! h 0 (add32 (vector-ref h 0) a))
              (vector-set! h 1 (add32 (vector-ref h 1) b))
              (vector-set! h 2 (add32 (vector-ref h 2) c))
              (vector-set! h 3 (add32 (vector-ref h 3) d))
              (vector-set! h 4 (add32 (vector-ref h 4) e))
              (vector-set! h 5 (add32 (vector-ref h 5) f))
              (vector-set! h 6 (add32 (vector-ref h 6) g))
              (vector-set! h 7 (add32 (vector-ref h 7) hh)))
            (chunk-loop (+ chunk 1)))))))

(define (bytevector->hex bv)
  (let ((digits "0123456789abcdef"))
    (let loop ((i 0) (out '()))
      (if (= i (bytevector-length bv))
          (list->string (reverse out))
          (let ((b (bytevector-u8-ref bv i)))
            (loop (+ i 1)
                  (cons (string-ref digits (bitwise-and b #xF))
                        (cons (string-ref digits (bitwise-and (bitwise-arithmetic-shift-right b 4) #xF)) out))))))))

(define (concat-bv a b)
  (let* ((an (bytevector-length a)) (bn (bytevector-length b))
         (out (make-bytevector (+ an bn) 0)))
    (let loop ((i 0))
      (when (< i an)
        (bytevector-u8-set! out i (bytevector-u8-ref a i))
        (loop (+ i 1))))
    (let loop ((i 0))
      (when (< i bn)
        (bytevector-u8-set! out (+ an i) (bytevector-u8-ref b i))
        (loop (+ i 1))))
    out))

(define TREE-DOMAIN
  (string->utf8 (string-append "dsh/source-tree/v2" (string (integer->char 0)))))

(define (tree-hash source . rule-id)
  (bytevector->hex
    (sha256 (concat-bv TREE-DOMAIN
                       (if (null? rule-id)
                           (canonical-source-bytes source)
                           (canonical-source-bytes source (car rule-id)))))))
